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
import type { CompiledRedactionRule } from './regex-redact.ts';
import { makeTruncate } from './output-truncation.ts';
import { resolveTimeSeconds, resolveTimeISO, resolveTimeRange } from './time-resolution.ts';
import { clampLimit } from './tool-config.ts';
import { formatHttpErrorMessage, runDispatchedQuery } from './http.ts';

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
const DEFAULT_LOOKBACK_MS = 3_600_000;
const truncate = makeTruncate(MAX_RESULT_CHARS, 'use a narrower time range, smaller limit, or more specific query');

/**
 * Datadog range resolution always has a concrete `to` default (the current
 * time), so — unlike the shared `ResolvedTimeRange<T>` — `to` here is never
 * actually null in the success case. The non-null-`defaultTo` overload of
 * `resolveTimeRange` gives us that guarantee statically.
 */
type ResolvedRange<T> = { from: T; to: T } | { error: string };

function resolveISORange(
  from: string | null | undefined,
  to: string | null | undefined,
  nowMs: number,
): ResolvedRange<string> {
  return resolveTimeRange(
    from,
    to,
    nowMs,
    resolveTimeISO,
    new Date(nowMs - DEFAULT_LOOKBACK_MS).toISOString(),
    new Date(nowMs).toISOString(),
  );
}

function resolveSecondsRange(
  from: string | null | undefined,
  to: string | null | undefined,
  nowMs: number,
): ResolvedRange<number> {
  return resolveTimeRange(
    from,
    to,
    nowMs,
    resolveTimeSeconds,
    Math.floor((nowMs - DEFAULT_LOOKBACK_MS) / 1_000),
    Math.floor(nowMs / 1_000),
  );
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

/**
 * Issue a request against a Datadog endpoint and resolve to either the raw
 * response text or a formatted error message. Centralizes the
 * fetch + buildHeaders + !response.ok handling shared by all query types.
 */
async function fetchDatadog(
  url: URL,
  config: DatadogConfig,
  signal: AbortSignal,
  queryType: string,
  init?: { method?: string; body?: string },
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const response = await fetch(url.toString(), {
    method: init?.method ?? 'GET',
    headers: buildHeaders(config),
    body: init?.body,
    signal,
  });
  if (!response.ok) return { ok: false, error: await formatHttpErrorMessage(response, `Datadog ${queryType}`) };
  return { ok: true, text: await response.text() };
}

async function queryMetrics(
  params: DatadogQueryParams,
  config: DatadogConfig,
  signal: AbortSignal,
): Promise<string> {
  if (!params.query?.trim()) {
    return 'Error: query is required for metrics (e.g. "avg:system.cpu.user{*}" or "avg:kubernetes.cpu.usage.total{cluster_name:prod}").';
  }
  const range = resolveSecondsRange(params.from, params.to, Date.now());
  if ('error' in range) return range.error;
  const { from: fromSec, to: toSec } = range;

  const url = new URL(`${baseUrl(config)}/api/v1/query`);
  url.searchParams.set('query', params.query.trim());
  url.searchParams.set('from', String(fromSec));
  url.searchParams.set('to', String(toSec));

  const result = await fetchDatadog(url, config, signal, 'metrics');
  return result.ok ? result.text : result.error;
}

async function queryLogs(
  params: DatadogQueryParams,
  config: DatadogConfig,
  signal: AbortSignal,
): Promise<string> {
  const range = resolveISORange(params.from, params.to, Date.now());
  if ('error' in range) return range.error;
  const { from, to } = range;

  const limit = clampLimit(params.limit, DEFAULT_LIMIT, MAX_LIMIT);

  const filterObj: Record<string, unknown> = { from, to };
  if (params.query?.trim()) filterObj['query'] = params.query.trim();
  if (params.indexes?.trim()) {
    filterObj['indexes'] = params.indexes.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const body = JSON.stringify({
    filter: filterObj,
    sort: 'timestamp',
    page: { limit },
  });

  const url = new URL(`${baseUrl(config)}/api/v2/logs/events/search`);
  const result = await fetchDatadog(url, config, signal, 'logs', { method: 'POST', body });
  return result.ok ? result.text : result.error;
}

async function queryEvents(
  params: DatadogQueryParams,
  config: DatadogConfig,
  signal: AbortSignal,
): Promise<string> {
  const range = resolveISORange(params.from, params.to, Date.now());
  if ('error' in range) return range.error;
  const { from, to } = range;

  const limit = clampLimit(params.limit, DEFAULT_LIMIT, MAX_LIMIT);

  const url = new URL(`${baseUrl(config)}/api/v2/events`);
  url.searchParams.set('filter[from]', from);
  url.searchParams.set('filter[to]', to);
  url.searchParams.set('page[limit]', String(limit));
  url.searchParams.set('sort', '-timestamp');
  if (params.query?.trim()) url.searchParams.set('filter[query]', params.query.trim());
  if (params.tags?.trim()) url.searchParams.set('filter[tags]', params.tags.trim());

  const result = await fetchDatadog(url, config, signal, 'events');
  return result.ok ? result.text : result.error;
}

/**
 * Client-side status filter for the /api/v1/monitor response: keep only
 * entries whose overall_state matches one of the comma-separated
 * monitorStatus values (case-insensitive). Returns `text` unchanged when
 * monitorStatus is unset, or when `text` isn't a JSON array.
 */
export function filterMonitorsByStatus(text: string, monitorStatus?: string | null): string {
  if (!monitorStatus?.trim()) return text;

  const allowedStates = new Set(
    monitorStatus.split(',').map((s) => s.trim().toLowerCase()),
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
  return text;
}

async function queryMonitors(
  params: DatadogQueryParams,
  config: DatadogConfig,
  signal: AbortSignal,
): Promise<string> {
  const limit = clampLimit(params.limit, DEFAULT_LIMIT, MAX_LIMIT);

  // group_states=all enriches the response with per-group state data.
  // It is NOT a filter — status filtering is applied client-side below.
  const url = new URL(`${baseUrl(config)}/api/v1/monitor`);
  url.searchParams.set('page_size', String(limit));
  url.searchParams.set('page', '0');
  url.searchParams.set('group_states', 'all');
  if (params.query?.trim()) url.searchParams.set('name', params.query.trim());
  if (params.tags?.trim()) url.searchParams.set('monitor_tags', params.tags.trim());

  const result = await fetchDatadog(url, config, signal, 'monitors');
  if (!result.ok) return result.error;
  return filterMonitorsByStatus(result.text, params.monitorStatus);
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

  return runDispatchedQuery(config.timeoutMs, 'Datadog', config.regexRedactionRules ?? [], truncate, (signal) => {
    switch (params.queryType) {
      case 'metrics':
        return queryMetrics(params, config, signal);
      case 'logs':
        return queryLogs(params, config, signal);
      case 'events':
        return queryEvents(params, config, signal);
      case 'monitors':
        return queryMonitors(params, config, signal);
    }
  });
}
