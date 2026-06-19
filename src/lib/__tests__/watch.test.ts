import { describe, it, expect } from 'vitest';
import {
  parseEventLine,
  matchesWatchFilter,
  buildDiagnosticPrompt,
  formatFinding,
  eventCooldownKey,
  shouldDiagnose,
  computeBackoffMs,
  shouldResetBackoff,
  type K8sEventObject,
  type WatchFilterConfig,
  type CooldownState,
} from '../watch.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<K8sEventObject> = {}): K8sEventObject {
  return {
    kind: 'Event',
    metadata: { name: 'evt-abc123', namespace: 'default' },
    involvedObject: { kind: 'Pod', name: 'api-xyz', namespace: 'default' },
    reason: 'BackOff',
    message: 'Back-off restarting failed container',
    type: 'Warning',
    ...overrides,
  };
}

function serialize(event: K8sEventObject): string {
  return JSON.stringify(event);
}

// ---------------------------------------------------------------------------
// parseEventLine
// ---------------------------------------------------------------------------

describe('parseEventLine', () => {
  it('parses a raw Event JSON line', () => {
    const event = makeEvent();
    const result = parseEventLine(serialize(event));
    expect(result).not.toBeNull();
    expect(result?.reason).toBe('BackOff');
    expect(result?.type).toBe('Warning');
  });

  it('unwraps a Watch wrapper {type, object}', () => {
    const event = makeEvent();
    const wrapped = JSON.stringify({ type: 'ADDED', object: event });
    const result = parseEventLine(wrapped);
    expect(result).not.toBeNull();
    expect(result?.reason).toBe('BackOff');
  });

  it('returns null for empty / whitespace-only lines', () => {
    expect(parseEventLine('')).toBeNull();
    expect(parseEventLine('   ')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseEventLine('not json')).toBeNull();
    expect(parseEventLine('{broken')).toBeNull();
  });

  it('returns null when kind is not Event', () => {
    const pod = { kind: 'Pod', metadata: { name: 'x', namespace: 'default' } };
    expect(parseEventLine(JSON.stringify(pod))).toBeNull();
  });

  it('returns null when reason is missing', () => {
    const bad = { kind: 'Event', metadata: {}, involvedObject: {}, message: 'x' };
    expect(parseEventLine(JSON.stringify(bad))).toBeNull();
  });

  it('returns null when message is missing', () => {
    const bad = { kind: 'Event', metadata: {}, involvedObject: {}, reason: 'BackOff' };
    expect(parseEventLine(JSON.stringify(bad))).toBeNull();
  });

  it('returns null for a non-object JSON value', () => {
    expect(parseEventLine('"just a string"')).toBeNull();
    expect(parseEventLine('42')).toBeNull();
    expect(parseEventLine('null')).toBeNull();
  });

  it('handles MODIFIED and DELETED watch wrappers', () => {
    for (const type of ['MODIFIED', 'DELETED']) {
      const wrapped = JSON.stringify({ type, object: makeEvent() });
      expect(parseEventLine(wrapped)).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// matchesWatchFilter
// ---------------------------------------------------------------------------

describe('matchesWatchFilter', () => {
  it('accepts a Warning event with empty filter config', () => {
    expect(matchesWatchFilter(makeEvent({ type: 'Warning' }), {})).toBe(true);
  });

  it('rejects Normal events', () => {
    expect(matchesWatchFilter(makeEvent({ type: 'Normal' }), {})).toBe(false);
  });

  it('rejects events whose type is undefined', () => {
    const event = makeEvent();
    delete (event as Partial<K8sEventObject>).type;
    expect(matchesWatchFilter(event, {})).toBe(false);
  });

  it('accepts when namespace is in the allowed list', () => {
    const config: WatchFilterConfig = { namespaces: ['prod', 'staging'] };
    expect(matchesWatchFilter(makeEvent({ metadata: { namespace: 'prod' } }), config)).toBe(true);
    expect(matchesWatchFilter(makeEvent({ metadata: { namespace: 'staging' } }), config)).toBe(true);
  });

  it('rejects when namespace is not in the allowed list', () => {
    const config: WatchFilterConfig = { namespaces: ['prod'] };
    expect(matchesWatchFilter(makeEvent({ metadata: { namespace: 'default' } }), config)).toBe(false);
  });

  it('falls back to involvedObject.namespace when metadata.namespace is absent', () => {
    const event = makeEvent({
      metadata: { name: 'e' },
      involvedObject: { kind: 'Pod', name: 'x', namespace: 'prod' },
    });
    const config: WatchFilterConfig = { namespaces: ['prod'] };
    expect(matchesWatchFilter(event, config)).toBe(true);
  });

  it('accepts when reason is in the allowed list', () => {
    const config: WatchFilterConfig = { reasons: ['OOMKilled', 'BackOff'] };
    expect(matchesWatchFilter(makeEvent({ reason: 'OOMKilled' }), config)).toBe(true);
    expect(matchesWatchFilter(makeEvent({ reason: 'BackOff' }), config)).toBe(true);
  });

  it('rejects when reason is not in the allowed list', () => {
    const config: WatchFilterConfig = { reasons: ['OOMKilled'] };
    expect(matchesWatchFilter(makeEvent({ reason: 'BackOff' }), config)).toBe(false);
  });

  it('treats null namespace/reason lists the same as empty (accept all)', () => {
    const config: WatchFilterConfig = { namespaces: null, reasons: null };
    expect(matchesWatchFilter(makeEvent(), config)).toBe(true);
  });

  it('applies both namespace and reason filters together', () => {
    const config: WatchFilterConfig = { namespaces: ['prod'], reasons: ['OOMKilled'] };
    expect(matchesWatchFilter(makeEvent({ metadata: { namespace: 'prod' }, reason: 'OOMKilled' }), config)).toBe(true);
    // right namespace, wrong reason
    expect(matchesWatchFilter(makeEvent({ metadata: { namespace: 'prod' }, reason: 'BackOff' }), config)).toBe(false);
    // right reason, wrong namespace
    expect(matchesWatchFilter(makeEvent({ metadata: { namespace: 'staging' }, reason: 'OOMKilled' }), config)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildDiagnosticPrompt
// ---------------------------------------------------------------------------

describe('buildDiagnosticPrompt', () => {
  it('includes namespace, object kind/name, reason, and message', () => {
    const event = makeEvent({
      metadata: { namespace: 'prod' },
      involvedObject: { kind: 'Pod', name: 'api-7f9b' },
      reason: 'OOMKilled',
      message: 'Container used too much memory',
    });
    const prompt = buildDiagnosticPrompt(event);
    expect(prompt).toContain('prod');
    expect(prompt).toContain('Pod/api-7f9b');
    expect(prompt).toContain('OOMKilled');
    expect(prompt).toContain('Container used too much memory');
  });

  it('falls back to "unknown" when fields are absent', () => {
    const event = makeEvent({
      metadata: {},
      involvedObject: {},
    });
    const prompt = buildDiagnosticPrompt(event);
    expect(prompt).toContain('unknown');
  });

  it('includes a call-to-action asking for diagnosis', () => {
    const prompt = buildDiagnosticPrompt(makeEvent());
    expect(prompt.toLowerCase()).toMatch(/diagnos/);
  });
});

// ---------------------------------------------------------------------------
// formatFinding
// ---------------------------------------------------------------------------

describe('formatFinding', () => {
  it('includes all required fields', () => {
    const event = makeEvent({
      metadata: { namespace: 'staging' },
      involvedObject: { kind: 'Deployment', name: 'payments' },
      reason: 'Unhealthy',
      message: 'Liveness probe failed',
    });
    const ts = '2026-06-19T05:00:00.000Z';
    const finding = formatFinding(event, ts);

    expect(finding.ts).toBe(ts);
    expect(finding.namespace).toBe('staging');
    expect(finding.reason).toBe('Unhealthy');
    expect(finding.objectKind).toBe('Deployment');
    expect(finding.objectName).toBe('payments');
    expect(finding.message).toBe('Liveness probe failed');
    expect(finding.diagnosis).toBeUndefined();
  });

  it('includes diagnosis when provided', () => {
    const finding = formatFinding(makeEvent(), '2026-06-19T00:00:00Z', 'Likely OOM from a memory leak');
    expect(finding.diagnosis).toBe('Likely OOM from a memory leak');
  });

  it('falls back to involvedObject namespace when metadata namespace is absent', () => {
    const event = makeEvent({
      metadata: { name: 'e' },
      involvedObject: { kind: 'Pod', name: 'x', namespace: 'kube-system' },
    });
    const finding = formatFinding(event, 'ts');
    expect(finding.namespace).toBe('kube-system');
  });

  it('is JSON-serialisable', () => {
    const finding = formatFinding(makeEvent(), 'ts', 'diag');
    expect(() => JSON.stringify(finding)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(finding));
    expect(parsed.reason).toBe('BackOff');
    expect(parsed.diagnosis).toBe('diag');
  });
});

// ---------------------------------------------------------------------------
// eventCooldownKey
// ---------------------------------------------------------------------------

describe('eventCooldownKey', () => {
  it('builds key from namespace, involved-object kind/name, and reason when no uid', () => {
    const event = makeEvent({
      metadata: { namespace: 'prod' },
      involvedObject: { kind: 'Pod', name: 'api-xyz' },
      reason: 'BackOff',
    });
    expect(eventCooldownKey(event)).toBe('prod/Pod/api-xyz/BackOff');
  });

  it('prefers involvedObject.uid over kind/name when uid is present', () => {
    const event = makeEvent({
      metadata: { namespace: 'prod' },
      involvedObject: { kind: 'Pod', name: 'api-xyz', uid: 'abc-123' },
      reason: 'BackOff',
    });
    expect(eventCooldownKey(event)).toBe('prod/abc-123/BackOff');
  });

  it('treats a recreated object (same name, different uid) as a new key', () => {
    const original = makeEvent({
      metadata: { namespace: 'prod' },
      involvedObject: { kind: 'Pod', name: 'web-0', uid: 'uid-v1' },
      reason: 'BackOff',
    });
    const recreated = makeEvent({
      metadata: { namespace: 'prod' },
      involvedObject: { kind: 'Pod', name: 'web-0', uid: 'uid-v2' },
      reason: 'BackOff',
    });
    expect(eventCooldownKey(original)).not.toBe(eventCooldownKey(recreated));
  });

  it('falls back to involvedObject.namespace when metadata.namespace is absent', () => {
    const event = makeEvent({
      metadata: { name: 'evt' },
      involvedObject: { kind: 'Pod', name: 'x', namespace: 'staging' },
      reason: 'OOMKilled',
    });
    expect(eventCooldownKey(event)).toBe('staging/Pod/x/OOMKilled');
  });

  it('uses empty string when no namespace is present', () => {
    const event = makeEvent({ metadata: {}, involvedObject: { kind: 'Pod', name: 'x' } });
    expect(eventCooldownKey(event)).toBe('/Pod/x/BackOff');
  });

  it('produces distinct keys for different reasons on the same object', () => {
    const a = makeEvent({ reason: 'BackOff' });
    const b = makeEvent({ reason: 'OOMKilled' });
    expect(eventCooldownKey(a)).not.toBe(eventCooldownKey(b));
  });

  it('produces distinct keys for the same reason on different objects', () => {
    const a = makeEvent({ involvedObject: { kind: 'Pod', name: 'pod-1' } });
    const b = makeEvent({ involvedObject: { kind: 'Pod', name: 'pod-2' } });
    expect(eventCooldownKey(a)).not.toBe(eventCooldownKey(b));
  });
});

// ---------------------------------------------------------------------------
// shouldDiagnose
// ---------------------------------------------------------------------------

describe('shouldDiagnose', () => {
  it('returns true and records state on first occurrence', () => {
    const state: CooldownState = new Map();
    expect(shouldDiagnose(makeEvent(), state, 1_000, 300)).toBe(true);
    expect(state.size).toBe(1);
  });

  it('suppresses a repeat within the cooldown window', () => {
    const state: CooldownState = new Map();
    const event = makeEvent();
    shouldDiagnose(event, state, 1_000, 300);
    // 100 s later — still within 300 s window
    expect(shouldDiagnose(event, state, 1_000 + 100_000, 300)).toBe(false);
  });

  it('re-diagnoses after the cooldown window expires', () => {
    const state: CooldownState = new Map();
    const event = makeEvent();
    shouldDiagnose(event, state, 1_000, 300);
    // 1 ms before expiry: still suppressed
    expect(shouldDiagnose(event, state, 1_000 + 299_999, 300)).toBe(false);
    // Exactly at expiry boundary (elapsed === cooldown ms): no longer suppressed
    expect(shouldDiagnose(event, state, 1_000 + 300_000, 300)).toBe(true);
  });

  it('treats distinct (object, reason) keys independently', () => {
    const state: CooldownState = new Map();
    const e1 = makeEvent({ involvedObject: { kind: 'Pod', name: 'pod-1' } });
    const e2 = makeEvent({ involvedObject: { kind: 'Pod', name: 'pod-2' } });
    shouldDiagnose(e1, state, 1_000, 300);
    // e2 has a different key; must be diagnosed
    expect(shouldDiagnose(e2, state, 1_001, 300)).toBe(true);
    // e1 is still suppressed
    expect(shouldDiagnose(e1, state, 1_002, 300)).toBe(false);
  });

  it('treats the same object with different reasons as distinct keys', () => {
    const state: CooldownState = new Map();
    shouldDiagnose(makeEvent({ reason: 'BackOff' }), state, 1_000, 300);
    expect(shouldDiagnose(makeEvent({ reason: 'OOMKilled' }), state, 1_001, 300)).toBe(true);
  });

  it('a cooldownSeconds of 0 effectively disables suppression', () => {
    const state: CooldownState = new Map();
    const event = makeEvent();
    shouldDiagnose(event, state, 1_000, 0);
    // next call at the same timestamp: 0 s window → never suppressed (returns before updating state)
    expect(shouldDiagnose(event, state, 1_000, 0)).toBe(true);
  });

  it('prunes expired entries when state exceeds 10 000 entries', () => {
    const state: CooldownState = new Map();
    const now = 1_000_000;
    const cooldown = 300;
    // Pre-fill with 10 000 entries that are all expired
    for (let i = 0; i < 10_000; i++) {
      state.set(`dummy-${i}`, now - (cooldown + 1) * 1_000);
    }
    // Adding a new event should trigger pruning of all expired entries
    shouldDiagnose(makeEvent(), state, now, cooldown);
    // Only the new entry should remain
    expect(state.size).toBe(1);
  });

  it('evicts oldest (LRU) entries when map is full with all non-expired entries', () => {
    const state: CooldownState = new Map();
    const now = 1_000_000;
    const cooldown = 300;
    // Pre-fill with 10 000 unexpired entries — none will be pruned by expiry scan
    for (let i = 0; i < 10_000; i++) {
      state.set(`active-${i}`, now - 10_000); // 10 s old, well within 300 s window
    }
    // Triggering a new event must not throw and must keep map at ≤ MAX_COOLDOWN_ENTRIES
    shouldDiagnose(makeEvent(), state, now, cooldown);
    expect(state.size).toBeLessThanOrEqual(10_000);
    // The new event's key must be in the map (it should be inserted after eviction)
    const newKey = eventCooldownKey(makeEvent());
    expect(state.has(newKey)).toBe(true);
  });

  it('uses uid in key so a pod recreated with the same name gets a fresh cooldown', () => {
    const state: CooldownState = new Map();
    const original = makeEvent({ involvedObject: { kind: 'Pod', name: 'web-0', uid: 'uid-v1' } });
    const recreated = makeEvent({ involvedObject: { kind: 'Pod', name: 'web-0', uid: 'uid-v2' } });
    shouldDiagnose(original, state, 1_000, 300);
    // Even immediately after, the recreated pod with a different uid is a fresh key
    expect(shouldDiagnose(recreated, state, 1_001, 300)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeBackoffMs
// ---------------------------------------------------------------------------

describe('computeBackoffMs', () => {
  it('returns baseMs for attempt 0 with zero jitter', () => {
    expect(computeBackoffMs(0, { baseMs: 1_000, capMs: 30_000, jitter: 0 }, () => 0)).toBe(1_000);
  });

  it('doubles on each attempt (exponential growth)', () => {
    const opts = { baseMs: 1_000, capMs: 30_000, jitter: 0 };
    expect(computeBackoffMs(1, opts, () => 0)).toBe(2_000);
    expect(computeBackoffMs(2, opts, () => 0)).toBe(4_000);
    expect(computeBackoffMs(3, opts, () => 0)).toBe(8_000);
  });

  it('caps at capMs', () => {
    const opts = { baseMs: 1_000, capMs: 5_000, jitter: 0 };
    expect(computeBackoffMs(10, opts, () => 0)).toBe(5_000);
    expect(computeBackoffMs(100, opts, () => 0)).toBe(5_000);
  });

  it('applies jitter: random=0 gives the minimum (raw × (1 - jitter))', () => {
    const opts = { baseMs: 1_000, capMs: 30_000, jitter: 0.3 };
    expect(computeBackoffMs(0, opts, () => 0)).toBe(700); // 1000 × 0.7
  });

  it('applies jitter: random=1 gives the maximum (raw × (1 + jitter))', () => {
    const opts = { baseMs: 1_000, capMs: 30_000, jitter: 0.3 };
    expect(computeBackoffMs(0, opts, () => 1)).toBe(1_300); // 1000 × 1.3
  });

  it('result is within [raw*(1-jitter), raw*(1+jitter)] for all attempts', () => {
    const opts = { baseMs: 1_000, capMs: 30_000, jitter: 0.25 };
    for (const attempt of [0, 1, 2, 3, 5]) {
      const raw = Math.min(opts.baseMs * (2 ** attempt), opts.capMs);
      const lo = Math.floor(raw * (1 - opts.jitter));
      const hi = Math.ceil(raw * (1 + opts.jitter));
      for (const r of [0, 0.25, 0.5, 0.75, 1]) {
        const result = computeBackoffMs(attempt, opts, () => r);
        expect(result).toBeGreaterThanOrEqual(lo);
        expect(result).toBeLessThanOrEqual(hi);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// shouldResetBackoff
// ---------------------------------------------------------------------------

describe('shouldResetBackoff', () => {
  it('returns true when uptime meets the threshold', () => {
    expect(shouldResetBackoff(60_000, 60_000)).toBe(true);
    expect(shouldResetBackoff(61_000, 60_000)).toBe(true);
    expect(shouldResetBackoff(1_000_000, 60_000)).toBe(true);
  });

  it('returns false when uptime is below the threshold', () => {
    expect(shouldResetBackoff(59_999, 60_000)).toBe(false);
    expect(shouldResetBackoff(0, 60_000)).toBe(false);
  });
});
