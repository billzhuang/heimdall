import { describe, it, expect } from 'vitest';
import {
  parseEventLine,
  matchesWatchFilter,
  buildDiagnosticPrompt,
  formatFinding,
  type K8sEventObject,
  type WatchFilterConfig,
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
