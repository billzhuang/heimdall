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
import { resolveTimeISO } from './time-resolution.ts';
import { makeTruncate } from './output-truncation.ts';
import { clampLimit } from './tool-config.ts';
import { formatQueryError, withTimeout } from './http.ts';

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
const truncate = makeTruncate(MAX_RESULT_CHARS, 'use a narrower time range, smaller limit, or more specific query');

/** Resolve a Heimdall-style time expression to ISO8601 for NRQL SINCE/UNTIL clauses. */
export const resolveNrqlTime = resolveTimeISO;


/** Execute a NerdGraph GraphQL query and return the raw JSON response text. */
async function nerdgraph(
  gql: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(NERDGRAPH_URL, {
    method: 'POST',
    headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json' },
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
  const q = params.query?.trim() ?? '';
  if (!q) {
    return 'Error: query is required for metrics (e.g. "SELECT average(cpuPercent) FROM SystemSample SINCE 1 hour ago").';
  }

  let nrql = q;
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
    nrql += ` LIMIT ${clampLimit(params.limit, DEFAULT_LIMIT, MAX_LIMIT)}`;
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

  const qApm = params.query?.trim() ?? '';
  const whereClause = qApm ? `WHERE ${qApm} ` : '';
  const untilClause = until ? ` UNTIL '${until}'` : '';
  const lim = clampLimit(params.limit, DEFAULT_LIMIT, MAX_LIMIT);

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
  const qAlerts = params.query?.trim() ?? '';
  const extraWhere = qAlerts ? ` AND (${qAlerts})` : '';
  const untilClause = until ? ` UNTIL '${until}'` : '';
  const lim = clampLimit(params.limit, DEFAULT_LIMIT, MAX_LIMIT);

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

  try {
    return await withTimeout(config.timeoutMs, async (signal) => {
      let raw: string;
      switch (params.queryType) {
        case 'metrics':
          raw = await queryMetrics(params, config, signal);
          break;
        case 'apm':
          raw = await queryApm(params, config, signal);
          break;
        case 'alerts':
          raw = await queryAlerts(params, config, signal);
          break;
      }
      return truncate(applyRedaction(raw, config.regexRedactionRules ?? []));
    });
  } catch (err) {
    return formatQueryError(err, 'New Relic', config.timeoutMs, config.regexRedactionRules ?? []);
  }
}
