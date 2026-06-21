/**
 * Pure HTTP helpers for New Relic NerdGraph API access (read-only).
 *
 * All three query types funnel through the NerdGraph GraphQL endpoint using NRQL:
 *   metrics — arbitrary NRQL query (SELECT ... FROM ... SINCE ...)
 *   apm     — Transaction throughput/error rate for a named service
 *   alerts  — open NrAiIncident violations in the last 24 hours
 *
 * API key and account ID come from trusted config/env — never from
 * model-selected arguments.
 */
import { applyRedaction, type CompiledRedactionRule } from './regex-redact.ts';
import { parseDurationMs } from './duration.ts';

export interface NewRelicConfig {
  apiKey: string;
  accountId: string;
  timeoutMs: number;
  regexRedactionRules?: CompiledRedactionRule[];
}

export type NewRelicQueryType = 'metrics' | 'apm' | 'alerts';

export interface NewRelicQueryParams {
  queryType: NewRelicQueryType;
  /**
   * For metrics: any valid NRQL query string (e.g. "SELECT average(cpuPercent) FROM SystemSample SINCE 1 hour ago").
   * For apm: NRQL WHERE clause filter (e.g. "appName = 'payments'"). If omitted, all apps are returned.
   * For alerts: optional NRQL WHERE filter on NrAiIncident (e.g. "priority = 'CRITICAL'").
   */
  query?: string | null;
  /**
   * Start of the time range (SINCE clause). Accepts relative ("-1h", "-30m", "-2d"),
   * ISO8601 ("2024-06-01T00:00:00Z"), or NRQL time literals ("1 hour ago", "1 day ago").
   * Defaults to "-1h".
   */
  from?: string | null;
  /**
   * End of the time range (UNTIL clause). Same formats as from. Defaults to now.
   */
  to?: string | null;
  /** Maximum number of results returned (LIMIT clause). Default 100, max 2000. */
  limit?: number | null;
}

const NERDGRAPH_URL = 'https://api.newrelic.com/graphql';
const MAX_RESULT_CHARS = 20_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 2_000;

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS) +
    '\n\n[Output truncated — use a narrower time range, smaller limit, or more specific query]'
  );
}

/**
 * Convert a Heimdall-style relative duration or ISO8601 string to an ISO8601
 * timestamp for use in NRQL SINCE/UNTIL clauses (single-quoted).
 *
 * - Relative starting with '-': subtract duration from nowMs and return ISO8601.
 * - ISO8601 / RFC3339: pass through as-is.
 * - Bare integer (epoch seconds or milliseconds): convert to ISO8601.
 * - Returns null when the expression cannot be resolved.
 */
export function resolveNrqlTime(expr: string, nowMs: number): string | null {
  if (expr.startsWith('-')) {
    const durationMs = parseDurationMs(expr.slice(1));
    if (durationMs === null) return null;
    if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
    return new Date(nowMs - durationMs).toISOString();
  }
  // Bare integer → epoch
  if (/^\d{1,13}$/.test(expr)) {
    const n = Number(expr);
    const ms = expr.length <= 10 ? n * 1_000 : n;
    return new Date(ms).toISOString();
  }
  // ISO8601 — pass through
  if (!Number.isNaN(Date.parse(expr))) return expr;
  return null;
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'Api-Key': apiKey,
    'Content-Type': 'application/json',
  };
}

function effectiveLimit(limit: number | null | undefined): number {
  if (typeof limit === 'number' && Number.isFinite(limit)) {
    return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
  }
  return DEFAULT_LIMIT;
}

/** Execute a NerdGraph GraphQL query and return the raw JSON response text. */
async function nerdgraph(
  gql: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(NERDGRAPH_URL, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify({ query: gql }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const detail = body ? `: ${body.slice(0, 200)}` : '';
    return `New Relic NerdGraph HTTP ${response.status} ${response.statusText}${detail}`;
  }
  return await response.text();
}

async function queryMetrics(
  params: NewRelicQueryParams,
  config: NewRelicConfig,
  signal: AbortSignal,
): Promise<string> {
  if (!params.query?.trim()) {
    return 'Error: query is required for metrics (e.g. "SELECT average(cpuPercent) FROM SystemSample SINCE 1 hour ago").';
  }

  let nrql = params.query.trim();
  const nowMs = Date.now();

  if (params.from) {
    const since = resolveNrqlTime(params.from, nowMs);
    if (since === null) return `Error: could not parse "from" time: "${params.from}".`;
    if (!/\bSINCE\b/i.test(nrql)) nrql += ` SINCE '${since}'`;
  }
  if (params.to) {
    const until = resolveNrqlTime(params.to, nowMs);
    if (until === null) return `Error: could not parse "to" time: "${params.to}".`;
    if (!/\bUNTIL\b/i.test(nrql)) nrql += ` UNTIL '${until}'`;
  }
  if (!/\bLIMIT\b/i.test(nrql)) {
    nrql += ` LIMIT ${effectiveLimit(params.limit)}`;
  }

  const gql = `{
  actor {
    account(id: ${config.accountId}) {
      nrql(query: ${JSON.stringify(nrql)}) {
        results
        metadata { facets timeWindow { begin end since until } }
      }
    }
  }
}`;

  return nerdgraph(gql, config.apiKey, signal);
}

async function queryApm(
  params: NewRelicQueryParams,
  config: NewRelicConfig,
  signal: AbortSignal,
): Promise<string> {
  const nowMs = Date.now();
  const since = params.from ? resolveNrqlTime(params.from, nowMs) : new Date(nowMs - 3_600_000).toISOString();
  const until = params.to ? resolveNrqlTime(params.to, nowMs) : null;

  if (since === null) return `Error: could not parse "from" time: "${params.from}".`;
  if (params.to && until === null) return `Error: could not parse "to" time: "${params.to}".`;

  const whereClause = params.query?.trim() ? `WHERE ${params.query.trim()} ` : '';
  const untilClause = until ? ` UNTIL '${until}'` : '';
  const lim = effectiveLimit(params.limit);

  const nrql = `SELECT count(*) AS throughput, average(duration) AS avgDuration, percentage(count(*), WHERE error IS true) AS errorRate FROM Transaction ${whereClause}SINCE '${since}'${untilClause} FACET appName LIMIT ${lim}`;

  const gql = `{
  actor {
    account(id: ${config.accountId}) {
      nrql(query: ${JSON.stringify(nrql)}) {
        results
        metadata { facets timeWindow { begin end } }
      }
    }
  }
}`;

  return nerdgraph(gql, config.apiKey, signal);
}

async function queryAlerts(
  params: NewRelicQueryParams,
  config: NewRelicConfig,
  signal: AbortSignal,
): Promise<string> {
  const nowMs = Date.now();
  const since = params.from ? resolveNrqlTime(params.from, nowMs) : new Date(nowMs - 86_400_000).toISOString();
  const until = params.to ? resolveNrqlTime(params.to, nowMs) : null;

  if (since === null) return `Error: could not parse "from" time: "${params.from}".`;
  if (params.to && until === null) return `Error: could not parse "to" time: "${params.to}".`;

  // Wrap in parentheses so OR in the filter doesn't escape the event='open' predicate.
  const extraWhere = params.query?.trim() ? ` AND (${params.query.trim()})` : '';
  const untilClause = until ? ` UNTIL '${until}'` : '';
  const lim = effectiveLimit(params.limit);

  // NrAiIncident captures New Relic AI (applied intelligence) incidents.
  // Filtering event = 'open' surfaces currently active violations.
  const nrql = `SELECT title, priority, state, accumulations.policyName, accumulations.conditionName, accumulations.entityName, createdAt FROM NrAiIncident WHERE event = 'open'${extraWhere} SINCE '${since}'${untilClause} LIMIT ${lim}`;

  const gql = `{
  actor {
    account(id: ${config.accountId}) {
      nrql(query: ${JSON.stringify(nrql)}) {
        results
        metadata { timeWindow { begin end } }
      }
    }
  }
}`;

  return nerdgraph(gql, config.apiKey, signal);
}

/**
 * Execute a read-only New Relic NerdGraph query and return the JSON response.
 *
 * Routes to the appropriate NRQL query based on queryType, applies a request
 * timeout, truncates output to avoid blowing the model's context, and applies
 * regex redaction rules before returning.
 */
export async function runNewRelicQuery(
  params: NewRelicQueryParams,
  config: NewRelicConfig,
): Promise<string> {
  if (!config.apiKey) {
    return 'Error: New Relic API key is not configured. Set the NEW_RELIC_API_KEY environment variable, or add apiKey to the newRelic section in heimdall.config.yaml.';
  }
  if (!config.accountId) {
    return 'Error: New Relic account ID is not configured. Set the NEW_RELIC_ACCOUNT_ID environment variable, or add accountId to the newRelic section in heimdall.config.yaml.';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    let raw: string;
    switch (params.queryType) {
      case 'metrics':
        raw = await queryMetrics(params, config, controller.signal);
        break;
      case 'apm':
        raw = await queryApm(params, config, controller.signal);
        break;
      case 'alerts':
        raw = await queryAlerts(params, config, controller.signal);
        break;
    }
    return truncate(applyRedaction(raw, config.regexRedactionRules ?? []));
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return `New Relic query timed out after ${config.timeoutMs}ms.`;
    }
    const message = err instanceof Error ? err.message : String(err);
    return `New Relic query failed: ${applyRedaction(message, config.regexRedactionRules ?? [])}`;
  } finally {
    clearTimeout(timer);
  }
}
