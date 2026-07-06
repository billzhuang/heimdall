/**
 * Alert payload parser for the `heimdall alert` subcommand.
 *
 * Supports AlertManager v4 webhook payloads (used by both Grafana and Prometheus
 * Alertmanager), PagerDuty V2 and V3 webhook payloads, and a plain "raw" text
 * source. Extracts structured fields from alert labels/annotations so the
 * investigation prompt is concise and targeted.
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

/** Narrows `v` to a non-null, non-array object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Parse an AlertManager v4 webhook payload.
 * Returns one `ParsedAlert` per firing alert entry.
 */
export function parseAlertManagerPayload(payload: unknown): ParsedAlert[] {
  if (!isPlainObject(payload)) return [];
  const p = payload as AlertManagerPayload;
  const raw = Array.isArray(p.alerts) ? p.alerts : [];
  return raw.filter((a): a is AlertManagerAlert => typeof a === 'object' && a !== null && !Array.isArray(a)).map((a) => parseOneAlert(a));
}

function parseOneAlert(alert: AlertManagerAlert): ParsedAlert {
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

// ── PagerDuty V2 types ─────────────────────────────────────────────────────

interface PagerDutyV2Incident {
  id?: string;
  title?: string;
  status?: string;
  urgency?: string;
  service?: { id?: string; name?: string };
  links?: Array<{ href?: string; text?: string }>;
}

interface PagerDutyV2Message {
  type?: string;
  // V2 wraps under data.incident; some older/variant payloads expose incident at the top level.
  data?: { incident?: PagerDutyV2Incident };
  incident?: PagerDutyV2Incident;
}

interface PagerDutyV2Payload {
  messages?: PagerDutyV2Message[];
}

// ── PagerDuty V3 types ─────────────────────────────────────────────────────

interface PagerDutyV3Incident {
  id?: string;
  number?: number;
  title?: string;
  status?: string;
  urgency?: string;
  // V3 service references use `summary` as the display name; `name` is absent.
  service?: { id?: string; name?: string; summary?: string };
  // For non-incident events (annotated, status_update), the real incident is nested here.
  type?: string;
  incident?: PagerDutyV3Incident;
}

interface PagerDutyV3Payload {
  event?: { event_type?: string; data?: PagerDutyV3Incident };
  events?: Array<{ event_type?: string; data?: PagerDutyV3Incident }>;
}

/**
 * Maps PagerDuty service names to K8s targets.
 * Values are "namespace" or "namespace/deployment".
 */
export type PagerDutyServiceMap = Record<string, string>;

/** Normalised incident fields extracted from a PagerDuty V2 or V3 webhook. */
interface PdIncidentRef {
  title?: string;
  id?: string;
  status?: string;
  urgency?: string;
  serviceName?: string;
  runbookUrl?: string;
}

function resolveServiceTarget(
  serviceName: string | undefined,
  serviceMap: PagerDutyServiceMap,
): { namespace?: string; deployment?: string } {
  if (!serviceName) return {};
  const mapped = serviceMap[serviceName];
  if (!mapped) return {};
  const slash = mapped.indexOf('/');
  if (slash === -1) return { namespace: mapped };
  return { namespace: mapped.slice(0, slash), deployment: mapped.slice(slash + 1) };
}

function pdUrgencyToSeverity(urgency?: string): string | undefined {
  if (urgency === 'high') return 'critical';
  if (urgency === 'low') return 'warning';
  return urgency;
}

/**
 * Resolve the alert's deployment field from a serviceMap lookup.
 * Falls back to the raw PagerDuty service name only when the service wasn't
 * found in serviceMap at all — a mapped entry with no deployment (namespace
 * only) deliberately leaves deployment unset rather than falling back.
 */
function resolveDeploymentFallback(
  mapped: { namespace?: string; deployment?: string },
  serviceName: string | undefined,
): string | undefined {
  return mapped.deployment ?? (mapped.namespace !== undefined ? undefined : serviceName);
}

function buildPdAlert(incident: PdIncidentRef, serviceMap: PagerDutyServiceMap): ParsedAlert {
  const { title, id, status, urgency, serviceName, runbookUrl } = incident;
  const mapped = resolveServiceTarget(serviceName, serviceMap);
  const labels: Record<string, string> = {};
  if (id) labels['incident_id'] = id;
  if (status) labels['status'] = status;
  if (serviceName) labels['service'] = serviceName;
  if (runbookUrl) labels['runbook_url'] = runbookUrl;
  return {
    alertname: title ?? id ?? 'PagerDuty Incident',
    namespace: mapped.namespace,
    deployment: resolveDeploymentFallback(mapped, serviceName),
    severity: pdUrgencyToSeverity(urgency),
    labels,
  };
}

/**
 * Parse a PagerDuty V2 webhook payload (`{ messages: [...] }`).
 * Returns one `ParsedAlert` per incident message.
 */
export function parsePagerDutyV2Payload(
  payload: unknown,
  serviceMap: PagerDutyServiceMap = {},
): ParsedAlert[] {
  if (!isPlainObject(payload)) return [];
  const p = payload as PagerDutyV2Payload;
  const messages = Array.isArray(p.messages) ? p.messages : [];
  return messages.flatMap((msg) => {
    // Support both data-wrapped (`msg.data.incident`) and flat (`msg.incident`) V2 shapes.
    const incident = msg?.data?.incident ?? msg?.incident;
    if (!incident) return [];
    const runbookUrl = incident.links
      ?.find((l) => l?.text?.toLowerCase()?.includes('runbook'))
      ?.href;
    return [buildPdAlert(
      { title: incident.title, id: incident.id, status: incident.status, urgency: incident.urgency, serviceName: incident.service?.name, runbookUrl },
      serviceMap,
    )];
  });
}

/**
 * Parse a PagerDuty V3 webhook payload (`{ event: {...} }` or `{ events: [...] }`).
 * Returns one `ParsedAlert` per incident event.
 */
export function parsePagerDutyV3Payload(
  payload: unknown,
  serviceMap: PagerDutyServiceMap = {},
): ParsedAlert[] {
  if (!isPlainObject(payload)) return [];
  const p = payload as PagerDutyV3Payload;
  const eventList = Array.isArray(p.events) && p.events.length > 0
    ? p.events
    : p.event
      ? [p.event]
      : [];
  return eventList.flatMap((evt) => {
    const data = evt?.data;
    if (!data) return [];
    // For non-incident events (annotated, status_update, etc.), the real incident is nested under data.incident.
    const incident = data.incident ?? data;
    // V3 service references expose the display name as `summary`; fall back to `name` for compat.
    const serviceName = incident.service?.summary ?? incident.service?.name;
    return [buildPdAlert(
      { title: incident.title, id: incident.id, status: incident.status, urgency: incident.urgency, serviceName },
      serviceMap,
    )];
  });
}

/**
 * Auto-detect V2 vs V3 and parse a PagerDuty webhook payload.
 * Detects V2 by the presence of a `messages` array; otherwise tries V3.
 */
export function parsePagerDutyPayload(
  payload: unknown,
  serviceMap: PagerDutyServiceMap = {},
): ParsedAlert[] {
  if (!isPlainObject(payload)) return [];
  if (Array.isArray(payload['messages'])) return parsePagerDutyV2Payload(payload, serviceMap);
  return parsePagerDutyV3Payload(payload, serviceMap);
}

// ── buildAlertPrompt ─────────────────────────────────────────────────────────

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
