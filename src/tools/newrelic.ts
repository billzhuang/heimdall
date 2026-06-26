/**
 * The `newrelic_query` tool: read-only New Relic NerdGraph observability queries.
 *
 * Covers three query types via NerdGraph GraphQL / NRQL:
 *   metrics — arbitrary NRQL metric queries
 *   apm     — Transaction throughput, latency, and error rate per service
 *   alerts  — open NrAiIncident violations
 *
 * API key and account ID come from trusted config/env — never from
 * model-selected arguments.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { runNewRelicQuery, type NewRelicConfig } from '../lib/newrelic.ts';
import type { CompiledRedactionRule } from '../lib/regex-redact.ts';
import type { ToolPlugin } from '../lib/plugin.ts';

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Factory that bakes New Relic credentials and timeout into the tool closure.
 * Credentials are resolved from config → env → error; never from model input.
 */
export function makeNewRelicQuery(
  newRelicConfig?: {
    apiKey?: string | null;
    accountId?: string | null;
    timeoutMs?: number | null;
  } | null,
  regexRedactionRules?: CompiledRedactionRule[],
) {
  const apiKey = newRelicConfig?.apiKey || process.env.NEW_RELIC_API_KEY || '';
  const accountId = newRelicConfig?.accountId || process.env.NEW_RELIC_ACCOUNT_ID || '';
  const rawTimeout = newRelicConfig?.timeoutMs;

  const config: NewRelicConfig = {
    apiKey,
    accountId,
    timeoutMs:
      typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
        ? rawTimeout
        : DEFAULT_TIMEOUT_MS,
    regexRedactionRules,
  };

  return defineTool({
    name: 'newrelic_query',
    description:
      'Query New Relic for observability data via NerdGraph GraphQL API (read-only). Three query types:\n\n' +
      '**metrics** — run an arbitrary NRQL query against New Relic data.\n' +
      '  e.g. query="SELECT average(cpuPercent) FROM SystemSample SINCE 1 hour ago" to get CPU usage.\n' +
      '  Use standard NRQL syntax; include SINCE/UNTIL in the query itself, or use `from`/`to`.\n\n' +
      '**apm** — query Transaction throughput, average latency, and error rate, grouped by appName.\n' +
      '  Use `query` for a WHERE clause filter (e.g. "appName = \'payments\'").\n' +
      '  Use `from`/`to` to set the time window (default: last 1 hour).\n\n' +
      '**alerts** — list open New Relic AI incident violations.\n' +
      '  Use `query` for an additional WHERE clause filter (e.g. "priority = \'CRITICAL\'").\n' +
      '  Use `from` to set the lookback window (default: last 24 hours).\n\n' +
      '`from`/`to` accept ISO8601 timestamps, relative durations ("-1h", "-30m", "-2d"), or Unix seconds.',
    input: v.object({
      queryType: v.pipe(
        v.picklist(['metrics', 'apm', 'alerts']),
        v.description(
          '"metrics" for arbitrary NRQL queries; "apm" for Transaction throughput/latency/errors by service; ' +
          '"alerts" for open New Relic AI incident violations.',
        ),
      ),
      query: v.pipe(
        v.nullish(v.string()),
        v.description(
          'Query expression. For metrics: full NRQL string ' +
          '(e.g. "SELECT average(cpuPercent) FROM SystemSample SINCE 1 hour ago"). ' +
          'For apm: WHERE clause filter (e.g. "appName = \'payments\'"). ' +
          'For alerts: additional WHERE clause filter (e.g. "priority = \'CRITICAL\'").',
        ),
      ),
      from: v.pipe(
        v.nullish(v.string()),
        v.description(
          'Start of the time range. ISO8601 timestamp, relative duration ("-1h", "-30m", "-2d"), ' +
          'or Unix seconds. Defaults to 1 hour ago (apm/metrics) or 24 hours ago (alerts).',
        ),
      ),
      to: v.pipe(
        v.nullish(v.string()),
        v.description(
          'End of the time range. Same formats as `from`. Defaults to now.',
        ),
      ),
      limit: v.pipe(
        v.nullish(v.number()),
        v.description('Maximum number of results to return (default 100, max 2000).'),
      ),
    }),
    run: async ({ input: { queryType, query, from, to, limit } }) =>
      runNewRelicQuery({ queryType, query, from, to, limit }, config),
  });
}

export const newRelicPlugin: ToolPlugin = {
  key: 'newRelicQuery',
  factory: (config, rules) => makeNewRelicQuery(config.newRelic, rules),
};
