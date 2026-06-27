/**
 * The `loki_query` tool: read-only Grafana Loki log queries via LogQL.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { runLokiQuery, type LokiConfig } from '../lib/loki.ts';
import type { CompiledRedactionRule } from '../lib/regex-redact.ts';
import type { ToolPlugin } from '../lib/plugin.ts';
import { resolveTimeoutMs } from '../lib/tool-config.ts';

const DEFAULT_LOKI_URL = 'http://loki.monitoring:3100';
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Factory that bakes the Loki base URL, timeout, and optional namespace lockdown
 * into the tool closure. URL and credentials are never model-selected.
 */
export function makeLokiQuery(
  lokiConfig?: { url?: string | null; timeoutMs?: number | null } | null,
  regexRedactionRules?: CompiledRedactionRule[],
  lockedNamespace?: string | null,
) {
  const rawTimeout = lokiConfig?.timeoutMs;
  const config: LokiConfig = {
    url: lokiConfig?.url || process.env.LOKI_URL || DEFAULT_LOKI_URL,
    timeoutMs: resolveTimeoutMs(rawTimeout, DEFAULT_TIMEOUT_MS),
    regexRedactionRules,
    lockedNamespace: lockedNamespace ?? undefined,
  };

  const lockdownNote = lockedNamespace
    ? ` NAMESPACE LOCKDOWN ACTIVE: the stream selector must include namespace="${lockedNamespace}"; queries without it are blocked.`
    : '';

  return defineTool({
    name: 'loki_query',
    description:
      'Query Grafana Loki for structured log search using LogQL (read-only). ' +
      'Runs a log range query against the Loki HTTP API — never pushes or deletes logs.\n' +
      'Use this when you need label-based filtering, full-text search across multiple pods, ' +
      'or historical log retrieval beyond what `kubectl logs` can provide.\n\n' +
      'LogQL stream selector examples:\n' +
      '- All ERROR logs in a namespace: \'{namespace="prod"} |= "ERROR"\'\n' +
      '- Filter by app label: \'{namespace="prod", app="payments"} |= "timeout"\'\n' +
      '- Structured JSON logs: \'{namespace="prod", app="api"} | json | level="error"\'\n' +
      '- Specific pod: \'{namespace="prod", pod="worker-abc-xyz"} |~ "(?i)exception"\'\n\n' +
      'start/end accept ISO8601 timestamps or relative durations (e.g. "-1h", "-30m", "-2d"). ' +
      'Defaults: start="-1h", end=now, limit=100, direction=backward (newest first).' +
      lockdownNote,
    input: v.object({
      query: v.pipe(
        v.string(),
        v.description(
          'LogQL expression. Must include a stream selector, e.g. \'{namespace="prod", app="api"} |= "ERROR"\'. ' +
          'Use label matchers (=, !=, =~, !~) and line filters (|=, |~, !=) to narrow results.',
        ),
      ),
      start: v.pipe(
        v.nullish(v.string()),
        v.description(
          'Start of the query time range. ISO8601 timestamp or relative duration (e.g. "-1h", "-30m", "-2d"). Defaults to "-1h".',
        ),
      ),
      end: v.pipe(
        v.nullish(v.string()),
        v.description(
          'End of the query time range. ISO8601 timestamp or relative duration. Defaults to now.',
        ),
      ),
      limit: v.pipe(
        v.nullish(v.number()),
        v.description('Maximum number of log lines to return (default 100).'),
      ),
    }),
    run: async ({ input: { query, start, end, limit } }) =>
      runLokiQuery({ query, start, end, limit }, config),
  });
}

export const lokiPlugin: ToolPlugin = {
  key: 'lokiQuery',
  factory: (config, rules) => makeLokiQuery(config.loki, rules, config.namespace?.locked),
};
