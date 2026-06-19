/**
 * The `prometheus_query` tool: read-only Prometheus metric queries.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { runPrometheusQuery } from '../lib/prometheus.ts';
import type { PrometheusConfig } from '../lib/prometheus.ts';

const DEFAULT_PROMETHEUS_URL = 'http://prometheus-operated.monitoring:9090';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Factory that bakes the Prometheus base URL and timeout into the tool closure.
 * The URL is resolved from config → env → in-cluster default, never from the model.
 */
export function makePrometheusQuery(
  prometheusConfig?: { url?: string | null; timeoutMs?: number | null } | null,
) {
  const config: PrometheusConfig = {
    url: prometheusConfig?.url || process.env.PROMETHEUS_URL || DEFAULT_PROMETHEUS_URL,
    timeoutMs: prometheusConfig?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  return defineTool({
    name: 'prometheus_query',
    description:
      'Query Prometheus for time-series metrics using PromQL. Two query types:\n' +
      '- instant: evaluate a PromQL expression at a single point in time (defaults to now).\n' +
      '- range: evaluate a PromQL expression over a time window with a resolution step.\n' +
      'Use this to inspect golden signals (request rate, error rate, latency, saturation) and resource trends that kubectl cannot show.',
    parameters: v.object({
      queryType: v.pipe(
        v.picklist(['instant', 'range']),
        v.description(
          '"instant" evaluates the expression at a single timestamp; "range" evaluates over a time window.',
        ),
      ),
      query: v.pipe(
        v.string(),
        v.description(
          'PromQL expression (e.g. \'rate(http_requests_total[5m])\', \'container_memory_usage_bytes{namespace="prod"}\').',
        ),
      ),
      time: v.pipe(
        v.optional(v.string()),
        v.description(
          'Evaluation timestamp for instant queries: RFC3339 or Unix seconds. Omit for the current time.',
        ),
      ),
      start: v.pipe(
        v.optional(v.string()),
        v.description('Start time for range queries: RFC3339 or Unix seconds. Required for range queries.'),
      ),
      end: v.pipe(
        v.optional(v.string()),
        v.description('End time for range queries: RFC3339 or Unix seconds. Required for range queries.'),
      ),
      step: v.pipe(
        v.optional(v.string()),
        v.description(
          'Resolution step for range queries (e.g. "15s", "1m", "5m"). Required for range queries.',
        ),
      ),
    }),
    execute: async ({ queryType, query, time, start, end, step }) =>
      runPrometheusQuery(queryType, { query, time, start, end, step }, config),
  });
}
