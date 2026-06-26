/**
 * The `jaeger_query` tool: read-only distributed trace queries via Jaeger HTTP API.
 *
 * Compatible with both Jaeger Query (port 16686) and Grafana Tempo (via its
 * Jaeger-compatible API). Point `jaeger.url` in heimdall.config.yaml at either.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { runJaegerQuery, type JaegerConfig } from '../lib/jaeger.ts';
import type { CompiledRedactionRule } from '../lib/regex-redact.ts';
import type { ToolPlugin } from '../lib/plugin.ts';

const DEFAULT_JAEGER_URL = 'http://jaeger-query.tracing:16686';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Factory that bakes the Jaeger base URL and timeout into the tool closure.
 * URL and credentials are never model-selected.
 */
export function makeJaegerQuery(
  jaegerConfig?: { url?: string | null; timeoutMs?: number | null } | null,
  regexRedactionRules?: CompiledRedactionRule[],
) {
  const rawTimeout = jaegerConfig?.timeoutMs;
  const config: JaegerConfig = {
    url: jaegerConfig?.url || process.env.JAEGER_URL || DEFAULT_JAEGER_URL,
    timeoutMs:
      typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
        ? rawTimeout
        : DEFAULT_TIMEOUT_MS,
    regexRedactionRules,
  };

  return defineTool({
    name: 'jaeger_query',
    description:
      'Query Jaeger or Grafana Tempo for distributed traces (read-only). ' +
      'Fetches recent traces for a service, surfacing slow spans, error spans, and upstream dependency issues.\n\n' +
      'Compatible with Jaeger Query API and Grafana Tempo Jaeger-compatible frontend — both expose /api/traces.\n\n' +
      'Typical workflows:\n' +
      '- Find slowest traces for a service: service="checkout", minDuration="1s", limit=5\n' +
      '- Filter by operation/span: service="payments", operation="POST /charge"\n' +
      '- Time-bounded search: service="api-gateway", start="-1h", end="-30m"\n' +
      '- Find error traces: service="orders", tags="error=true"\n\n' +
      'start/end accept ISO8601 timestamps, relative durations (e.g. "-1h", "-30m"), or Unix second epoch. ' +
      'Defaults: limit=20, start=last hour (when Jaeger enforces a default). ' +
      'minDuration uses Jaeger duration format: "1s", "500ms", "1.5s".',
    input: v.object({
      service: v.pipe(
        v.string(),
        v.description(
          'Service name to query traces for (e.g. "checkout", "payments-api"). ' +
          'Must match the service.name reported by the instrumented application.',
        ),
      ),
      operation: v.pipe(
        v.nullish(v.string()),
        v.description(
          'Filter by operation/span name (e.g. "GET /api/orders", "POST /charge", "db.query"). ' +
          'Omit to return traces across all operations for the service.',
        ),
      ),
      start: v.pipe(
        v.nullish(v.string()),
        v.description(
          'Start of the time range. ISO8601 timestamp, relative duration (e.g. "-1h", "-30m"), ' +
          'or Unix second epoch. Omit to use the Jaeger server default (typically the last hour).',
        ),
      ),
      end: v.pipe(
        v.nullish(v.string()),
        v.description(
          'End of the time range. ISO8601 timestamp, relative duration, or Unix second epoch. ' +
          'Omit to default to now.',
        ),
      ),
      limit: v.pipe(
        v.nullish(v.number()),
        v.description('Maximum number of traces to return (default 20, max 100).'),
      ),
      minDuration: v.pipe(
        v.nullish(v.string()),
        v.description(
          'Minimum trace duration filter — returns only traces at least this long. ' +
          'Jaeger duration format: "1s", "500ms", "1.5s". Useful for isolating slow requests.',
        ),
      ),
      tags: v.pipe(
        v.nullish(v.string()),
        v.description(
          'Space-separated key=value tag filters (e.g. "http.status_code=500 error=true"). ' +
          'Matches traces where at least one span carries all specified tags.',
        ),
      ),
    }),
    run: async ({ input: { service, operation, start, end, limit, minDuration, tags } }) =>
      runJaegerQuery({ service, operation, start, end, limit, minDuration, tags }, config),
  });
}

export const jaegerPlugin: ToolPlugin = {
  key: 'jaegerQuery',
  factory: (config, rules) => makeJaegerQuery(config.jaeger, rules),
};
