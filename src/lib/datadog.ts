/**
 * Pure HTTP helpers for Datadog API access (read-only).
 *
 * Covers four read-only endpoints:
 *   metrics   — GET /api/v1/query (Dogstatsd/metric query)
 *   logs      — POST /api/v2/logs/events/search
 *   events    — GET /api/v1/events
 *   monitors  — GET /api/v1/monitor
 *
 * API key, app key, and site come from trusted config/env — never from
 * model-selected arguments.
 */
import { applyRedaction, type CompiledRedactionRule } from './regex-redact.ts';
import { parseDurationMs } from './duration.ts';
import { makeTruncate } from './output-truncation.ts';

export interface DatadogConfig {
  apiKey: string;
  appKey: string;
  /** Datadog site hostname, e.g. "datadoghq.com" or "datadoghq.eu". */
  site: string;
  timeoutMs: number;
  regexRedactionRules?: CompiledRedactionRule[];
}

export type DatadogQueryType = 'metrics' | 'logs' | 'events' | 'monitors';

export interface DatadogQueryParams {
  queryType: DatadogQueryType;
  /** Metric query (metrics), log search query (logs), or monitor name filter (monitors). */
  query?: string | null;
  /**
   * Start of the time range.
   * Accepts ISO8601 ("2024-06-01T00:00:00Z"), relative ("-1h", "-30m", "-2d"),
   * or Unix seconds ("1717243200").
   */
  from?: string | null;
  /**
   * End of the time range (same formats as from). Defaults to now.
   */
  to?: string | null;
  /** Maximum number of results (logs, events, monitors). */
  limit?: number | null;
  /**
   * Log indexes to search (comma-separated, e.g. "main,security"). Logs only.
   * Omit to search all indexes.
   */
  indexes?: string | null;
  /**
   * Comma-separated tags to filter events (e.g. "env:prod,service:payments"). Events only.
   */
  tags?: string | null;
  /**
   * Comma-separated monitor group states to filter (e.g. "Alert,Warn,No Data"). Monitors only.
   * Valid values: Alert, Warn, No Data, OK, Ignored, Skipped.
   */
  monitorStatus?: string | null;
}

const MAX_RESULT_CHARS = 20_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;
const truncate = makeTruncate(MAX_RESULT_CHARS, 'use a narrower time range, smaller limit, or more specific query');

/**
 * Resolve a time expression to Unix seconds (integer) for Datadog APIs that
 * use epoch seconds (metrics, events).
 *
 * - Relative (starting with '-'): subtract parsed duration from nowMs.
 * - Bare integer ≤ 13 chars: treated as Unix seconds (≤ 10 digits) or
 *   Unix milliseconds (11–13 digits), both normalised to seconds.
 * - ISO8601 / RFC3339: parsed by Date and converted to seconds.
 * - Returns null when the expression cannot be resolved.
 */
export function resolveTimeSeconds(expr: string, nowMs: number): number | null {
  if (expr.startsWith('-')) {
    const durationMs = parseDurationMs(expr.slice(1));
    if (durationMs !== null) {
      const ts = nowMs - durationMs;
      if (!Number.isFinite(ts)) return null;
      return Math.floor(ts / 1_000);
    }
    return null;
  }
  if (/^\d{1,13}$/.test(expr)) {
    const n = Number(expr);
    // ≤ 10 digits: Unix seconds; 11–13 digits: Unix milliseconds
    return expr.length <= 10 ? n : Math.floor(n / 1_000);
  }
  const ts = Date.parse(expr);
  if (!Number.isNaN(ts)) return Math.floor(ts / 1_000);
  return null;
}

/**
 * Resolve a time expression to an ISO8601 string for Datadog APIs that accept
 * ISO8601 (logs API).
 *
 * - Relative (starting with '-'): resolve relative to nowMs and return ISO8601.
 * - Bare integer (epoch seconds or ms): convert to ISO8601.
 * - ISO8601 / RFC3339: pass through unchanged.
 * - Returns null when unresolvable.
 */
export function resolveTimeISO(expr: string, nowMs: number): string | null {
  if (expr.startsWith('-')) {
    const durationMs = parseDurationMs(expr.slice(1));
    if (durationMs !== null) {
      const ts = nowMs - durationMs;
      if (!Number.isFinite(ts)) return null;
      return new Date(ts).toISOString();
    }
    return null;
  }
  if (/^\d{1,13}$/.test(expr)) {
    const n = Number(expr);
    const ms = expr.length <= 10 ? n * 1_000 : n;
    return new Date(ms).toISOString();
  }
  const ts = Date.parse(expr);
  if (!Number.isNaN(ts)) return expr; // already valid ISO8601
  return null;
}

function buildHeaders(config: DatadogConfig): Record<string, string> {
  return {
    'DD-API-KEY': config.apiKey,
    'DD-APPLICATION-KEY': config.appKey,
    'Content-Type': 'application/json',
  };
}

function baseUrl(config: DatadogConfig): string {
  const site = config.site.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return `https://api.${site}`;
}

async function queryMetrics(
  params: DatadogQueryParams,
  config: DatadogConfig,
  signal: AbortSignal,
): Promise<string> {
  if (!params.query?.trim()) {
    return 'Error: query is required for metrics (e.g. "avg:system.cpu.user{*}" or "avg:kubernetes.cpu.usage.total{cluster_name:prod}").';
  }
  const nowMs = Date.now();
  const fromSec = params.from ? resolveTimeSeconds(params.from, nowMs) : Math.floor((nowMs - 3_600_000) / 1_000);
  const toSec = params.to ? resolveTimeSeconds(params.to, nowMs) : Math.floor(nowMs / 1_000);

  if (fromSec === null) return `Error: could not parse "from" time: "${params.from}".`;
  if (toSec === null) return `Error: could not parse "to" time: "${params.to}".`;

  const url = new URL(`${baseUrl(config)}/api/v1/query`);
  url.searchParams.set('query', params.query.trim());
  url.searchParams.set('from', String(fromSec));
  url.searchParams.set('to', String(toSec));

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: buildHeaders(config),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const detail = body ? `: ${body.slice(0, 200)}` : '';
    return `Datadog metrics HTTP ${response.status} ${response.statusText}${detail}`;
  }
  return await response.text();
}

async function queryLogs(
  params: DatadogQueryParams,
  config: DatadogConfig,
  signal: AbortSignal,
): Promise<string> {
  const nowMs = Date.now();
  const from = params.from ? resolveTimeISO(params.from, nowMs) : new Date(nowMs - 3_600_000).toISOString();
  const to = params.to ? resolveTimeISO(params.to, nowMs) : new Date(nowMs).toISOString();

  if (from === null) return `Error: could not parse "from" time: "${params.from}".`;
  if (to === null) return `Error: could not parse "to" time: "${params.to}".`;

  const effectiveLimit =
    typeof params.limit === 'number' && Number.isFinite(params.limit)
      ? Math.min(Math.max(Math.trunc(params.limit), 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

  const filterObj: Record<string, unknown> = { from, to };
  if (params.query?.trim()) filterObj['query'] = params.query.trim();
  if (params.indexes?.trim()) {
    filterObj['indexes'] = params.indexes.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const body = JSON.stringify({
    filter: filterObj,
    sort: 'timestamp',
    page: { limit: effectiveLimit },
  });

  const url = new URL(`${baseUrl(config)}/api/v2/logs/events/search`);
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: buildHeaders(config),
    body,
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const detail = text ? `: ${text.slice(0, 200)}` : '';
    return `Datadog logs HTTP ${response.status} ${response.statusText}${detail}`;
  }
  return await response.text();
}

async function queryEvents(
  params: DatadogQueryParams,
  config: DatadogConfig,
  signal: AbortSignal,
): Promise<string> {
  const nowMs = Date.now();
  // v2 Events API uses ISO8601 for from/to and supports free-text filter[query] and page[limit].
  const from = params.from ? resolveTimeISO(params.from, nowMs) : new Date(nowMs - 3_600_000).toISOString();
  const to = params.to ? resolveTimeISO(params.to, nowMs) : new Date(nowMs).toISOString();

  if (from === null) return `Error: could not parse "from" time: "${params.from}".`;
  if (to === null) return `Error: could not parse "to" time: "${params.to}".`;

  const effectiveLimit =
    typeof params.limit === 'number' && Number.isFinite(params.limit)
      ? Math.min(Math.max(Math.trunc(params.limit), 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

  const url = new URL(`${baseUrl(config)}/api/v2/events`);
  url.searchParams.set('filter[from]', from);
  url.searchParams.set('filter[to]', to);
  url.searchParams.set('page[limit]', String(effectiveLimit));
  url.searchParams.set('sort', '-timestamp');
  if (params.query?.trim()) url.searchParams.set('filter[query]', params.query.trim());
  if (params.tags?.trim()) url.searchParams.set('filter[tags]', params.tags.trim());

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: buildHeaders(config),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const detail = body ? `: ${body.slice(0, 200)}` : '';
    return `Datadog events HTTP ${response.status} ${response.statusText}${detail}`;
  }
  return await response.text();
}

async function queryMonitors(
  params: DatadogQueryParams,
  config: DatadogConfig,
  signal: AbortSignal,
): Promise<string> {
  const effectiveLimit =
    typeof params.limit === 'number' && Number.isFinite(params.limit)
      ? Math.min(Math.max(Math.trunc(params.limit), 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

  // group_states=all enriches the response with per-group state data.
  // It is NOT a filter — status filtering is applied client-side below.
  const url = new URL(`${baseUrl(config)}/api/v1/monitor`);
  url.searchParams.set('page_size', String(effectiveLimit));
  url.searchParams.set('page', '0');
  url.searchParams.set('group_states', 'all');
  if (params.query?.trim()) url.searchParams.set('name', params.query.trim());
  if (params.tags?.trim()) url.searchParams.set('monitor_tags', params.tags.trim());

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: buildHeaders(config),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const detail = body ? `: ${body.slice(0, 200)}` : '';
    return `Datadog monitors HTTP ${response.status} ${response.statusText}${detail}`;
  }

  const text = await response.text();

  // Client-side status filter: when monitorStatus is specified, keep only monitors
  // whose overall_state matches one of the requested states (case-insensitive).
  if (params.monitorStatus?.trim()) {
    const allowedStates = new Set(
      params.monitorStatus.split(',').map((s) => s.trim().toLowerCase()),
    );
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const filtered = parsed.filter((m: unknown) => {
          if (m !== null && typeof m === 'object' && 'overall_state' in m) {
            return allowedStates.has(String((m as Record<string, unknown>)['overall_state']).toLowerCase());
          }
          return false;
        });
        return JSON.stringify(filtered);
      }
    } catch {
      // JSON parse failed — return the raw text and let truncation/redaction apply
    }
  }

  return text;
}

/**
 * Execute a read-only Datadog query and return the raw JSON response as a string.
 *
 * Routes to the appropriate Datadog API endpoint based on queryType, applies a
 * request timeout, truncates output to avoid blowing the model's context, and
 * applies regex redaction rules before returning.
 */
export async function runDatadogQuery(
  params: DatadogQueryParams,
  config: DatadogConfig,
): Promise<string> {
  if (!config.apiKey) {
    return 'Error: Datadog API key is not configured. Set the DD_API_KEY or DATADOG_API_KEY environment variable, or add apiKey to the datadog section in heimdall.config.yaml.';
  }
  if (!config.appKey) {
    return 'Error: Datadog Application key is not configured. Set the DD_APP_KEY or DATADOG_APP_KEY environment variable, or add appKey to the datadog section in heimdall.config.yaml.';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    let raw: string;
    switch (params.queryType) {
      case 'metrics':
        raw = await queryMetrics(params, config, controller.signal);
        break;
      case 'logs':
        raw = await queryLogs(params, config, controller.signal);
        break;
      case 'events':
        raw = await queryEvents(params, config, controller.signal);
        break;
      case 'monitors':
        raw = await queryMonitors(params, config, controller.signal);
        break;
    }
    return truncate(applyRedaction(raw, config.regexRedactionRules ?? []));
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return `Datadog query timed out after ${config.timeoutMs}ms.`;
    }
    const message = err instanceof Error ? err.message : String(err);
    return `Datadog query failed: ${applyRedaction(message, config.regexRedactionRules ?? [])}`;
  } finally {
    clearTimeout(timer);
  }
}
