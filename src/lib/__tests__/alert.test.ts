import { describe, it, expect } from 'vitest';
import { parseAlertManagerPayload, buildAlertPrompt } from '../alert.ts';

// ── parseAlertManagerPayload ─────────────────────────────────────────────────

const ALERTMANAGER_PAYLOAD = {
  version: '4',
  receiver: 'webhook',
  status: 'firing',
  alerts: [
    {
      status: 'firing',
      labels: {
        alertname: 'PodCrashLooping',
        namespace: 'prod',
        pod: 'api-xyz-abc123',
        severity: 'critical',
        job: 'api',
      },
      annotations: {
        summary: 'Pod is crash looping',
        description: 'Pod api-xyz-abc123 has restarted 5 times in the last 10 minutes',
      },
    },
  ],
};

describe('parseAlertManagerPayload', () => {
  it('parses a standard AlertManager v4 payload', () => {
    const alerts = parseAlertManagerPayload(ALERTMANAGER_PAYLOAD);
    expect(alerts).toHaveLength(1);
    const a = alerts[0];
    expect(a.alertname).toBe('PodCrashLooping');
    expect(a.namespace).toBe('prod');
    expect(a.pod).toBe('api-xyz-abc123');
    expect(a.severity).toBe('critical');
    expect(a.deployment).toBe('api'); // falls back to labels.job
    expect(a.summary).toBe('Pod is crash looping');
    expect(a.description).toContain('restarted 5 times');
  });

  it('returns empty array for non-object input', () => {
    expect(parseAlertManagerPayload(null)).toEqual([]);
    expect(parseAlertManagerPayload('string')).toEqual([]);
    expect(parseAlertManagerPayload(42)).toEqual([]);
    expect(parseAlertManagerPayload([])).toEqual([]);
  });

  it('returns empty array when alerts array is missing', () => {
    expect(parseAlertManagerPayload({ version: '4' })).toEqual([]);
  });

  it('returns empty array for empty alerts array', () => {
    expect(parseAlertManagerPayload({ alerts: [] })).toEqual([]);
  });

  it('handles multiple alerts and returns all of them', () => {
    const payload = {
      alerts: [
        { labels: { alertname: 'Alert1', namespace: 'ns1' }, annotations: {} },
        { labels: { alertname: 'Alert2', namespace: 'ns2' }, annotations: {} },
      ],
    };
    const alerts = parseAlertManagerPayload(payload);
    expect(alerts).toHaveLength(2);
    expect(alerts[0].alertname).toBe('Alert1');
    expect(alerts[1].alertname).toBe('Alert2');
  });

  it('uses "Unknown" as alertname when missing', () => {
    const alerts = parseAlertManagerPayload({ alerts: [{ labels: {}, annotations: {} }] });
    expect(alerts[0].alertname).toBe('Unknown');
  });

  it('extracts pod name from instance label (strips port)', () => {
    const payload = {
      alerts: [
        { labels: { alertname: 'HighMemory', instance: 'my-pod-abc123:9090' }, annotations: {} },
      ],
    };
    const alerts = parseAlertManagerPayload(payload);
    expect(alerts[0].pod).toBe('my-pod-abc123');
  });

  it('populates labels with all string label values', () => {
    const alerts = parseAlertManagerPayload(ALERTMANAGER_PAYLOAD);
    expect(alerts[0].labels).toMatchObject({
      alertname: 'PodCrashLooping',
      namespace: 'prod',
      pod: 'api-xyz-abc123',
    });
  });

  it('prefers labels.deployment over labels.job for deployment field', () => {
    const payload = {
      alerts: [
        { labels: { alertname: 'Test', deployment: 'my-deploy', job: 'my-job' }, annotations: {} },
      ],
    };
    const alerts = parseAlertManagerPayload(payload);
    expect(alerts[0].deployment).toBe('my-deploy');
  });
});

// ── buildAlertPrompt ─────────────────────────────────────────────────────────

describe('buildAlertPrompt', () => {
  it('includes alertname and severity', () => {
    const prompt = buildAlertPrompt({
      alertname: 'PodCrashLooping',
      severity: 'critical',
      labels: {},
    });
    expect(prompt).toContain('PodCrashLooping');
    expect(prompt).toContain('critical');
  });

  it('includes namespace and pod when present', () => {
    const prompt = buildAlertPrompt({
      alertname: 'Test',
      namespace: 'prod',
      pod: 'api-xyz',
      labels: {},
    });
    expect(prompt).toContain('Namespace: prod');
    expect(prompt).toContain('Pod: api-xyz');
  });

  it('does not include namespace/pod lines when absent', () => {
    const prompt = buildAlertPrompt({ alertname: 'Test', labels: {} });
    expect(prompt).not.toContain('Namespace:');
    expect(prompt).not.toContain('Pod:');
  });

  it('embeds seed context in a code block when provided', () => {
    const prompt = buildAlertPrompt(
      { alertname: 'Test', labels: {} },
      'kubectl output here',
    );
    expect(prompt).toContain('Pre-fetched cluster context');
    expect(prompt).toContain('kubectl output here');
  });

  it('omits seed context section when not provided', () => {
    const prompt = buildAlertPrompt({ alertname: 'Test', labels: {} });
    expect(prompt).not.toContain('Pre-fetched cluster context');
  });

  it('includes extra labels that are not standard fields', () => {
    const prompt = buildAlertPrompt({
      alertname: 'Test',
      labels: { alertname: 'Test', cluster: 'prod-east', team: 'platform' },
    });
    expect(prompt).toContain('cluster: prod-east');
    expect(prompt).toContain('team: platform');
  });

  it('ends with a remediation ask', () => {
    const prompt = buildAlertPrompt({ alertname: 'Test', labels: {} });
    expect(prompt).toContain('remediation steps');
  });
});
