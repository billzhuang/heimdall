import { describe, it, expect } from 'vitest';
import {
  parseAlertManagerPayload,
  buildAlertPrompt,
  parsePagerDutyV2Payload,
  parsePagerDutyV3Payload,
  parsePagerDutyPayload,
} from '../alert.ts';

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

// ── parsePagerDutyV2Payload ──────────────────────────────────────────────────

const PD_V2_PAYLOAD = {
  messages: [
    {
      type: 'incident.trigger',
      data: {
        incident: {
          id: 'P123456',
          title: 'High CPU on api-server',
          status: 'triggered',
          urgency: 'high',
          service: { id: 'PIJ90N7', name: 'api-service' },
          links: [
            { href: 'https://wiki.example.com/runbooks/api', text: 'Runbook' },
          ],
        },
      },
    },
  ],
};

describe('parsePagerDutyV2Payload', () => {
  it('parses a standard V2 payload into a ParsedAlert', () => {
    const alerts = parsePagerDutyV2Payload(PD_V2_PAYLOAD);
    expect(alerts).toHaveLength(1);
    const a = alerts[0];
    expect(a.alertname).toBe('High CPU on api-server');
    expect(a.severity).toBe('critical'); // high → critical
    expect(a.labels['service']).toBe('api-service');
    expect(a.labels['incident_id']).toBe('P123456');
    expect(a.labels['status']).toBe('triggered');
    expect(a.labels['runbook_url']).toBe('https://wiki.example.com/runbooks/api');
  });

  it('applies serviceMap to populate namespace and deployment', () => {
    const alerts = parsePagerDutyV2Payload(PD_V2_PAYLOAD, {
      'api-service': 'prod/api',
    });
    expect(alerts[0].namespace).toBe('prod');
    expect(alerts[0].deployment).toBe('api');
  });

  it('applies serviceMap with namespace only (no deployment)', () => {
    const alerts = parsePagerDutyV2Payload(PD_V2_PAYLOAD, {
      'api-service': 'prod',
    });
    expect(alerts[0].namespace).toBe('prod');
    expect(alerts[0].deployment).toBeUndefined();
  });

  it('falls back to service name as deployment when no serviceMap entry', () => {
    const alerts = parsePagerDutyV2Payload(PD_V2_PAYLOAD);
    expect(alerts[0].namespace).toBeUndefined();
    expect(alerts[0].deployment).toBe('api-service');
  });

  it('maps urgency=low to severity=warning', () => {
    const payload = {
      messages: [{ data: { incident: { id: 'P1', title: 'Test', urgency: 'low', service: { name: 'svc' } } } }],
    };
    const alerts = parsePagerDutyV2Payload(payload);
    expect(alerts[0].severity).toBe('warning');
  });

  it('handles multiple messages and returns all alerts', () => {
    const payload = {
      messages: [
        { data: { incident: { id: 'P1', title: 'Incident 1', urgency: 'high', service: { name: 'svc-a' } } } },
        { data: { incident: { id: 'P2', title: 'Incident 2', urgency: 'low', service: { name: 'svc-b' } } } },
      ],
    };
    const alerts = parsePagerDutyV2Payload(payload);
    expect(alerts).toHaveLength(2);
    expect(alerts[0].alertname).toBe('Incident 1');
    expect(alerts[1].alertname).toBe('Incident 2');
  });

  it('returns empty array for non-object input', () => {
    expect(parsePagerDutyV2Payload(null)).toEqual([]);
    expect(parsePagerDutyV2Payload('string')).toEqual([]);
    expect(parsePagerDutyV2Payload([])).toEqual([]);
  });

  it('returns empty array when messages array is missing', () => {
    expect(parsePagerDutyV2Payload({})).toEqual([]);
  });

  it('skips messages without incident data', () => {
    const payload = { messages: [{ type: 'incident.trigger' }] };
    expect(parsePagerDutyV2Payload(payload)).toEqual([]);
  });
});

// ── parsePagerDutyV3Payload ──────────────────────────────────────────────────

const PD_V3_PAYLOAD = {
  event: {
    event_type: 'incident.triggered',
    data: {
      id: 'P789ABC',
      number: 7,
      title: 'Memory pressure on worker nodes',
      status: 'triggered',
      urgency: 'high',
      service: { id: 'SVC99', name: 'worker-pool' },
    },
  },
};

describe('parsePagerDutyV3Payload', () => {
  it('parses a single-event V3 payload', () => {
    const alerts = parsePagerDutyV3Payload(PD_V3_PAYLOAD);
    expect(alerts).toHaveLength(1);
    const a = alerts[0];
    expect(a.alertname).toBe('Memory pressure on worker nodes');
    expect(a.severity).toBe('critical');
    expect(a.labels['service']).toBe('worker-pool');
    expect(a.labels['incident_id']).toBe('P789ABC');
  });

  it('applies serviceMap to populate namespace and deployment', () => {
    const alerts = parsePagerDutyV3Payload(PD_V3_PAYLOAD, {
      'worker-pool': 'kube-system/node-agent',
    });
    expect(alerts[0].namespace).toBe('kube-system');
    expect(alerts[0].deployment).toBe('node-agent');
  });

  it('parses a batch V3 payload with multiple events', () => {
    const payload = {
      events: [
        { event_type: 'incident.triggered', data: { id: 'P1', title: 'Event 1', urgency: 'high', service: { name: 'svc-a' } } },
        { event_type: 'incident.triggered', data: { id: 'P2', title: 'Event 2', urgency: 'low', service: { name: 'svc-b' } } },
      ],
    };
    const alerts = parsePagerDutyV3Payload(payload);
    expect(alerts).toHaveLength(2);
    expect(alerts[0].alertname).toBe('Event 1');
    expect(alerts[1].alertname).toBe('Event 2');
  });

  it('returns empty array for non-object input', () => {
    expect(parsePagerDutyV3Payload(null)).toEqual([]);
    expect(parsePagerDutyV3Payload('string')).toEqual([]);
    expect(parsePagerDutyV3Payload([])).toEqual([]);
  });

  it('returns empty array when neither event nor events key is present', () => {
    expect(parsePagerDutyV3Payload({})).toEqual([]);
  });
});

// ── parsePagerDutyPayload (auto-detect) ──────────────────────────────────────

describe('parsePagerDutyPayload', () => {
  it('auto-detects V2 format when messages key is present', () => {
    const alerts = parsePagerDutyPayload(PD_V2_PAYLOAD);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].labels['incident_id']).toBe('P123456');
  });

  it('auto-detects V3 format when event key is present', () => {
    const alerts = parsePagerDutyPayload(PD_V3_PAYLOAD);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].labels['incident_id']).toBe('P789ABC');
  });

  it('passes serviceMap through to the underlying parser', () => {
    const alerts = parsePagerDutyPayload(PD_V2_PAYLOAD, { 'api-service': 'prod/api' });
    expect(alerts[0].namespace).toBe('prod');
    expect(alerts[0].deployment).toBe('api');
  });

  it('returns empty array for invalid input', () => {
    expect(parsePagerDutyPayload(null)).toEqual([]);
    expect(parsePagerDutyPayload(42)).toEqual([]);
  });
});

// ── buildAlertPrompt includes PagerDuty-specific labels ──────────────────────

describe('buildAlertPrompt with PagerDuty alert', () => {
  it('includes service and incident_id from PD labels', () => {
    const [alert] = parsePagerDutyV2Payload(PD_V2_PAYLOAD);
    const prompt = buildAlertPrompt(alert);
    expect(prompt).toContain('High CPU on api-server');
    expect(prompt).toContain('service: api-service');
    expect(prompt).toContain('incident_id: P123456');
  });

  it('includes runbook_url in labels section', () => {
    const [alert] = parsePagerDutyV2Payload(PD_V2_PAYLOAD);
    const prompt = buildAlertPrompt(alert);
    expect(prompt).toContain('runbook_url: https://wiki.example.com/runbooks/api');
  });
});
