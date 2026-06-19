/**
 * Alert payload parser for the `heimdall alert` subcommand.
 *
 * Supports AlertManager v4 webhook payloads (used by both Grafana and Prometheus
 * Alertmanager) and a plain "raw" text source. Extracts structured fields from
 * alert labels/annotations so the investigation prompt is concise and targeted.
 */

export interface ParsedAlert {
  alertname: string;
  /** Kubernetes namespace extracted from labels or annotations. */
  namespace?: string;
  /** Pod name extracted from labels (e.g. `labels.pod`). */
  pod?: string;
  /** Deployment / job name extracted from labels. */
  deployment?: string;
  severity?: string;
  summary?: string;
  description?: string;
  /** All label key→value pairs from the original alert. */
  labels: Record<string, string>;
}

/** Single alert in an AlertManager v4 payload. */
interface AlertManagerAlert {
  status?: string;
  labels?: Record<string, string | undefined>;
  annotations?: Record<string, string | undefined>;
}

/** Top-level AlertManager v4 webhook body. */
interface AlertManagerPayload {
  version?: string;
  receiver?: string;
  alerts?: AlertManagerAlert[];
}

/**
 * Parse an AlertManager v4 webhook payload.
 * Returns one `ParsedAlert` per firing alert entry.
 */
export function parseAlertManagerPayload(payload: unknown): ParsedAlert[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const p = payload as AlertManagerPayload;
  const raw = Array.isArray(p.alerts) ? p.alerts : [];
  return raw.flatMap((a) => {
    const parsed = parseOneAlert(a);
    return parsed ? [parsed] : [];
  });
}

function parseOneAlert(alert: AlertManagerAlert): ParsedAlert | null {
  const lbls = alert.labels ?? {};
  const ann = alert.annotations ?? {};

  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(lbls)) {
    if (typeof v === 'string') clean[k] = v;
  }

  return {
    alertname: clean.alertname ?? 'Unknown',
    namespace: clean.namespace,
    pod: clean.pod ?? extractPodFromInstance(clean.instance),
    deployment: clean.deployment ?? clean.job,
    severity: clean.severity,
    summary: typeof ann.summary === 'string' ? ann.summary : undefined,
    description: typeof ann.description === 'string' ? ann.description : undefined,
    labels: clean,
  };
}

/**
 * Kubernetes pod names often appear as `<host>:<port>` in the `instance` label.
 * Strips the port suffix and returns the host part if it looks like a pod name.
 */
function extractPodFromInstance(instance?: string): string | undefined {
  if (!instance) return undefined;
  const host = instance.split(':')[0];
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(host)) return host;
  return undefined;
}

/**
 * Build a targeted diagnostic prompt from a parsed alert.
 *
 * @param alert       - Structured alert data.
 * @param seedContext - Optional pre-fetched kubectl output to embed.
 */
export function buildAlertPrompt(alert: ParsedAlert, seedContext?: string): string {
  const lines: string[] = [
    'Investigate the following alert and determine the root cause:',
    '',
    `Alert: ${alert.alertname}${alert.severity ? ` (severity: ${alert.severity})` : ''}`,
  ];

  if (alert.namespace) lines.push(`Namespace: ${alert.namespace}`);
  if (alert.pod) lines.push(`Pod: ${alert.pod}`);
  if (alert.deployment) lines.push(`Deployment/Job: ${alert.deployment}`);
  if (alert.summary) lines.push(`Summary: ${alert.summary}`);
  if (alert.description) lines.push(`Description: ${alert.description}`);

  const SKIP = new Set(['alertname', 'namespace', 'pod', 'deployment', 'job', 'severity', 'instance']);
  const extra = Object.entries(alert.labels).filter(([k]) => !SKIP.has(k));
  if (extra.length > 0) {
    lines.push('Labels:');
    for (const [k, v] of extra) lines.push(`  ${k}: ${v}`);
  }

  if (seedContext) {
    lines.push('', 'Pre-fetched cluster context (collected before this investigation):', '```', seedContext, '```');
  }

  lines.push('', 'Diagnose the root cause, explain the impact, and suggest remediation steps.');
  return lines.join('\n');
}
