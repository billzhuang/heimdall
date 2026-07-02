/**
 * The `datadog_query` tool: read-only Datadog observability queries.
 *
 * Covers four Datadog data sources in a single tool:
 *   metrics  — time-series metric queries using Datadog's metrics query syntax
 *   logs     — full-text and structured log search (Logs Search API v2)
 *   events   — deployment markers, alert transitions, and infra events
 *   monitors — active monitors and their alert state
 *
 * API credentials (DD-API-KEY, DD-APPLICATION-KEY) and site come from trusted
 * config/env — never from model-selected arguments.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { runDatadogQuery, type DatadogConfig } from '../lib/datadog.ts';
import type { CompiledRedactionRule } from '../lib/regex-redact.ts';
import type { ToolPlugin } from '../lib/plugin.ts';
import { resolveConfigString, resolveTimeoutMs } from '../lib/tool-config.ts';

const DEFAULT_SITE = 'datadoghq.com';
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Factory that bakes Datadog credentials, site, and timeout into the tool closure.
 * Credentials are resolved from config → env → error; never from model input.
 */
export function makeDatadogQuery(
  datadogConfig?: {
    apiKey?: string | null;
    appKey?: string | null;
    site?: string | null;
    timeoutMs?: number | null;
  } | null,
  regexRedactionRules?: CompiledRedactionRule[],
) {
  const apiKey = resolveConfigString(datadogConfig?.apiKey, ['DD_API_KEY', 'DATADOG_API_KEY']);
  const appKey = resolveConfigString(datadogConfig?.appKey, ['DD_APP_KEY', 'DATADOG_APP_KEY']);
  const rawTimeout = datadogConfig?.timeoutMs;

  const config: DatadogConfig = {
    apiKey,
    appKey,
    site: resolveConfigString(datadogConfig?.site, 'DD_SITE', DEFAULT_SITE),
    timeoutMs: resolveTimeoutMs(rawTimeout, DEFAULT_TIMEOUT_MS),
    regexRedactionRules,
  };

  return defineTool({
    name: 'datadog_query',
    description:
      'Query Datadog for observability data (read-only). Four query types:\n\n' +
      '**metrics** — query time-series metrics using Datadog metric query syntax.\n' +
      '  e.g. query="avg:kubernetes.cpu.usage.total{cluster_name:prod}" to get CPU usage.\n' +
      '  Use `from`/`to` to set the time window (default: last 1 hour).\n\n' +
      '**logs** — search application and infrastructure logs using Datadog log query syntax.\n' +
      '  e.g. query="service:payments status:error" or query="@http.status_code:5*".\n' +
      '  Supports `limit` (default 100) and `indexes` (comma-separated, default: all).\n\n' +
      '**events** — list Datadog events: deployments, config changes, alerts, and infra events.\n' +
      '  Use `query` for free-text or tag filter, `tags` for tag-based filter (e.g. "env:prod,source:kubernetes").\n\n' +
      '**monitors** — list Datadog monitors and their alert state.\n' +
      '  Use `query` to filter by monitor name, `monitorStatus` for state filter\n' +
      '  (e.g. "Alert,Warn,No Data"), and `tags` for monitor tag filter.\n\n' +
      '`from`/`to` accept ISO8601 timestamps, relative durations ("-1h", "-30m", "-2d"), or Unix seconds.',
    input: v.object({
      queryType: v.pipe(
        v.picklist(['metrics', 'logs', 'events', 'monitors']),
        v.description(
          '"metrics" for time-series metric queries; "logs" for log search; ' +
          '"events" for infrastructure and deployment events; "monitors" for alert monitor state.',
        ),
      ),
      query: v.pipe(
        v.nullish(v.string()),
        v.description(
          'Query expression. For metrics: Datadog metric query syntax ' +
          '(e.g. "avg:kubernetes.cpu.usage.total{cluster_name:prod}"). ' +
          'For logs: Datadog log search syntax (e.g. "service:payments status:error"). ' +
          'For events: free-text or tag filter. For monitors: monitor name substring filter.',
        ),
      ),
      from: v.pipe(
        v.nullish(v.string()),
        v.description(
          'Start of the time range. ISO8601 timestamp, relative duration ("-1h", "-30m", "-2d"), ' +
          'or Unix seconds. Defaults to 1 hour ago.',
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
        v.description('Maximum number of results to return for logs, events, or monitors (default 100, max 1000).'),
      ),
      indexes: v.pipe(
        v.nullish(v.string()),
        v.description(
          'Comma-separated Datadog log indexes to search (e.g. "main,security"). ' +
          'Logs only. Omit to search all indexes.',
        ),
      ),
      tags: v.pipe(
        v.nullish(v.string()),
        v.description(
          'Comma-separated tag filter. For events: e.g. "env:prod,source:kubernetes". ' +
          'For monitors: monitor tag filter (e.g. "team:sre,env:prod").',
        ),
      ),
      monitorStatus: v.pipe(
        v.nullish(v.string()),
        v.description(
          'Comma-separated monitor group states to return. Monitors only. ' +
          'Valid values: Alert, Warn, No Data, OK, Ignored, Skipped. ' +
          'e.g. "Alert,Warn" to see only firing monitors.',
        ),
      ),
    }),
    run: async ({ input: { queryType, query, from, to, limit, indexes, tags, monitorStatus } }) =>
      runDatadogQuery({ queryType, query, from, to, limit, indexes, tags, monitorStatus }, config),
  });
}

export const datadogPlugin: ToolPlugin = {
  key: 'datadogQuery',
  factory: (config, rules) => makeDatadogQuery(config.datadog, rules),
};
