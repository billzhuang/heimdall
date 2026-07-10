/**
 * Pure functions for Heimdall's proactive watch mode.
 *
 * All I/O (spawning kubectl, calling the agent, posting webhooks) lives in
 * src/watch-mode.ts.  The functions here are side-effect-free so they can be
 * unit-tested without a cluster.
 */

import { postJsonWithTimeout } from './http.ts';

/** A Kubernetes Event object as returned by kubectl get events -o json --watch. */
export interface K8sEventObject {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name?: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
  };
  involvedObject: {
    kind?: string;
    name?: string;
    namespace?: string;
    apiVersion?: string;
    uid?: string;
  };
  reason: string;
  message: string;
  type?: string;
  count?: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  eventTime?: string | null;
  source?: {
    component?: string;
    host?: string;
  };
}

/** A processed finding emitted to stdout as a JSON line. */
export interface WatchFinding {
  ts: string;
  namespace: string;
  reason: string;
  objectKind: string;
  objectName: string;
  message: string;
  diagnosis?: string;
}

/** The subset of HeimdallConfig['watch'] used for filtering. */
export interface WatchFilterConfig {
  namespaces?: string[] | null;
  reasons?: string[] | null;
}

/** Opaque map of cooldown key → timestamp (ms) of last diagnosis. */
export type CooldownState = Map<string, number>;

const MAX_COOLDOWN_ENTRIES = 10_000;

export function eventNamespace(event: K8sEventObject, fallback = 'unknown'): string {
  return event.metadata.namespace ?? event.involvedObject.namespace ?? fallback;
}

/** Resolve the involved object's kind/name, falling back when either is absent. */
export function eventObjectRef(event: K8sEventObject): { kind: string; name: string } {
  return {
    kind: event.involvedObject.kind ?? 'Unknown',
    name: event.involvedObject.name ?? 'unknown',
  };
}

/**
 * Build the de-dup key for an event.
 * Uses `involvedObject.uid` when present so that a pod deleted and recreated
 * with the same name (e.g. `web-0`) gets a distinct key for its new lifecycle.
 * Falls back to `kind/name` when UID is absent (older kubectl / mock events).
 */
export function eventCooldownKey(event: K8sEventObject): string {
  const ns = eventNamespace(event, '');
  const { kind, name } = eventObjectRef(event);
  const objId = event.involvedObject.uid ?? `${kind}/${name}`;
  return `${ns}/${objId}/${event.reason}`;
}

/**
 * Enforce MAX_COOLDOWN_ENTRIES on a full cooldown map.
 *
 * The map is kept in LRU order (delete + re-insert on every write moves the key
 * to the end):
 *   1. Expired entries are pruned with an early-exit scan (O(k) where k = # expired).
 *   2. If the map is still full after pruning, the oldest (front) entries are evicted
 *      until we are under the cap — strictly enforcing the memory bound even when all
 *      entries are active (e.g. a burst of 10 000+ distinct object/reason pairs).
 */
function evictCooldownOverflow(state: CooldownState, nowMs: number, cooldownSeconds: number): void {
  const expiryMs = cooldownSeconds * 1_000;
  // Map is LRU-ordered: oldest entries are at the front. Break on first unexpired.
  for (const [k, ts] of state) {
    if (nowMs - ts >= expiryMs) {
      state.delete(k);
    } else {
      break;
    }
  }
  // Fallback: if still at cap (all entries unexpired), evict the oldest.
  if (state.size >= MAX_COOLDOWN_ENTRIES) {
    for (const [k] of state) {
      state.delete(k);
      if (state.size < MAX_COOLDOWN_ENTRIES) break;
    }
  }
}

/**
 * Return true when this event should trigger a new diagnosis.
 *
 * Suppresses re-diagnosis when the same (namespace, object, reason) key was
 * already diagnosed within `cooldownSeconds`.  When it returns true, the key's
 * last-seen time is updated in `state` so the caller does not need to track it.
 */
export function shouldDiagnose(
  event: K8sEventObject,
  state: CooldownState,
  nowMs: number,
  cooldownSeconds: number,
): boolean {
  const key = eventCooldownKey(event);
  const lastMs = state.get(key);
  if (lastMs !== undefined && nowMs - lastMs < cooldownSeconds * 1_000) {
    return false;
  }
  if (cooldownSeconds <= 0) {
    return true;
  }
  if (state.size >= MAX_COOLDOWN_ENTRIES) {
    evictCooldownOverflow(state, nowMs, cooldownSeconds);
  }
  // Delete before re-inserting to move this key to the most-recently-used position.
  state.delete(key);
  state.set(key, nowMs);
  return true;
}

/** Parameters for the exponential-backoff reconnect schedule. */
export interface BackoffOptions {
  /** Initial delay in ms (e.g. 1 000). */
  baseMs: number;
  /** Maximum delay in ms (e.g. 30 000). */
  capMs: number;
  /** Fractional jitter 0–1 applied symmetrically (e.g. 0.3 → ±30 %). */
  jitter: number;
}

/**
 * Compute the delay in milliseconds before the Nth reconnect attempt.
 *
 * Uses exponential backoff capped at `capMs`, with additive proportional jitter
 * so that a burst of reconnecting processes does not all retry simultaneously:
 *
 *   delay = clamp(baseMs × 2^attempt, capMs) × uniform(1-jitter, 1+jitter)
 *
 * @param attempt - zero-based attempt index (0 = first reconnect after initial failure)
 * @param opts    - backoff configuration
 * @param random  - RNG function (injectable for deterministic tests; defaults to Math.random)
 */
export function computeBackoffMs(
  attempt: number,
  opts: BackoffOptions,
  random: () => number = Math.random,
): number {
  const raw = Math.min(opts.baseMs * (2 ** attempt), opts.capMs);
  return Math.round(raw * (1 - opts.jitter + random() * opts.jitter * 2));
}

/**
 * Return true when the watch stream has been alive long enough that the
 * reconnect-attempt counter should be reset to 0.
 *
 * Prevents penalising the first failure after a long healthy run with a slow
 * backoff: if the stream was stable for `resetThresholdMs`, the next failure
 * is treated as a fresh first attempt.
 */
export function shouldResetBackoff(uptimeMs: number, resetThresholdMs: number): boolean {
  return uptimeMs >= resetThresholdMs;
}

/**
 * Parse a single stdout line from `kubectl get events --watch -o json`.
 *
 * kubectl --watch outputs one JSON object per line; the object is either:
 *   • A raw Event object (from `kubectl get events --watch -o json`)
 *   • A Watch event wrapper  {"type":"ADDED","object":{…Event…}}
 *     (from `kubectl events --watch -o json`)
 *
 * Returns null when the line is empty, non-JSON, or not a v1/Event.
 */
export function parseEventLine(line: string): K8sEventObject | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  // Unwrap Watch event wrappers: {"type":"ADDED","object":{…}}
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'type' in parsed &&
    'object' in parsed
  ) {
    parsed = (parsed as { type: string; object: unknown }).object;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;

  // Must be a Kubernetes Event resource with reason and message.
  if (obj['kind'] !== 'Event') return null;
  if (typeof obj['reason'] !== 'string') return null;
  if (typeof obj['message'] !== 'string') return null;
  if (typeof obj['metadata'] !== 'object' || obj['metadata'] === null) return null;
  if (typeof obj['involvedObject'] !== 'object' || obj['involvedObject'] === null) return null;

  return parsed as K8sEventObject;
}

/**
 * Return true when a Warning event should trigger a diagnosis.
 *
 * Filtering rules (all must pass):
 *   1. event.type must be "Warning"
 *   2. If config.namespaces is non-empty, the event's namespace must be in the list.
 *   3. If config.reasons is non-empty, the event's reason must be in the list.
 */
export function matchesWatchFilter(
  event: K8sEventObject,
  config: WatchFilterConfig,
): boolean {
  if (event.type !== 'Warning') return false;

  const { namespaces, reasons } = config;

  if (namespaces && namespaces.length > 0) {
    const ns = eventNamespace(event, '');
    if (!namespaces.includes(ns)) return false;
  }

  if (reasons && reasons.length > 0) {
    if (!reasons.includes(event.reason)) return false;
  }

  return true;
}

/**
 * Build the one-shot diagnostic prompt that is sent to the Heimdall agent
 * when a Warning event is received.
 */
export function buildDiagnosticPrompt(event: K8sEventObject): string {
  const ns = eventNamespace(event);
  const { kind: objKind, name: objName } = eventObjectRef(event);

  return [
    'A Kubernetes Warning event was just received:',
    `  Namespace:  ${ns}`,
    `  Object:     ${objKind}/${objName}`,
    `  Reason:     ${event.reason}`,
    `  Message:    ${event.message}`,
    '',
    'Diagnose this warning: what likely caused it, how serious is it, and what remediation steps should the operator take?',
  ].join('\n');
}

/** Format a processed event (with optional diagnosis) as a WatchFinding. */
export function formatFinding(
  event: K8sEventObject,
  ts: string,
  diagnosis?: string,
): WatchFinding {
  const { kind: objectKind, name: objectName } = eventObjectRef(event);
  const finding: WatchFinding = {
    ts,
    namespace: eventNamespace(event),
    reason: event.reason,
    objectKind,
    objectName,
    message: event.message,
  };
  if (diagnosis !== undefined) finding.diagnosis = diagnosis;
  return finding;
}

/**
 * POST a JSON payload to a webhook URL.
 * Uses the global `fetch` (Node.js 18+) with a 10-second timeout.
 * Throws on network error or non-2xx response.
 */
export async function postWebhook(webhookUrl: string, payload: unknown): Promise<void> {
  await postJsonWithTimeout(webhookUrl, payload, 10_000, async (res) => {
    // Consume body to free the connection, even on a non-2xx response.
    await res.text();
    if (!res.ok) {
      throw new Error(`webhook responded with HTTP ${res.status}`);
    }
  });
}
