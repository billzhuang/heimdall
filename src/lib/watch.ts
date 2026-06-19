/**
 * Pure functions for Heimdall's proactive watch mode.
 *
 * All I/O (spawning kubectl, calling the agent, posting webhooks) lives in
 * src/watch-mode.ts.  The functions here are side-effect-free so they can be
 * unit-tested without a cluster.
 */

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

/**
 * Build the de-dup key for an event: namespace + involved-object kind/name + reason.
 * Two events with the same key are considered the same repeating condition.
 */
export function eventCooldownKey(event: K8sEventObject): string {
  const ns = event.metadata.namespace ?? event.involvedObject.namespace ?? '';
  const kind = event.involvedObject.kind ?? 'Unknown';
  const name = event.involvedObject.name ?? 'unknown';
  return `${ns}/${kind}/${name}/${event.reason}`;
}

/**
 * Return true when this event should trigger a new diagnosis.
 *
 * Suppresses re-diagnosis when the same (namespace, object, reason) key was
 * already diagnosed within `cooldownSeconds`.  When it returns true, the key's
 * last-seen time is updated in `state` so the caller does not need to track it.
 *
 * Expired entries are pruned from `state` when it grows past MAX_COOLDOWN_ENTRIES
 * to keep memory bounded over long-running watch sessions.
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
  if (state.size >= MAX_COOLDOWN_ENTRIES) {
    const expiryMs = cooldownSeconds * 1_000;
    for (const [k, ts] of state) {
      if (nowMs - ts >= expiryMs) state.delete(k);
    }
  }
  state.set(key, nowMs);
  return true;
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
    const ns = event.metadata.namespace ?? event.involvedObject.namespace ?? '';
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
  const ns = event.metadata.namespace ?? event.involvedObject.namespace ?? 'unknown';
  const objKind = event.involvedObject.kind ?? 'Unknown';
  const objName = event.involvedObject.name ?? 'unknown';

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
  const finding: WatchFinding = {
    ts,
    namespace: event.metadata.namespace ?? event.involvedObject.namespace ?? 'unknown',
    reason: event.reason,
    objectKind: event.involvedObject.kind ?? 'Unknown',
    objectName: event.involvedObject.name ?? 'unknown',
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`webhook responded with HTTP ${res.status}`);
    }
    // Consume body to free the connection.
    await res.text();
  } finally {
    clearTimeout(timer);
  }
}
