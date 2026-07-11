/**
 * Pure HTTP helpers for Prometheus query API access.
 *
 * Supports instant queries (/api/v1/query) and range queries (/api/v1/query_range).
 * The Prometheus base URL and timeout come from trusted config/env — never from
 * model-selected arguments.
 */
import type { CompiledRedactionRule } from './regex-redact.ts';
import { makeTruncate } from './output-truncation.ts';
import { runJsonQuery } from './http.ts';
import { BLOCKED_PREFIX } from './harness.ts';
import { validateNamespaceSelectorLockdown } from './selector-lockdown.ts';

export interface PrometheusConfig {
  url: string;
  timeoutMs: number;
  /** User-configured regex redaction rules compiled at startup. */
  regexRedactionRules?: CompiledRedactionRule[];
  /** When set, all queries are rejected unless every vector selector includes namespace="<value>". */
  lockedNamespace?: string;
}

/**
 * Check that every PromQL vector selector in a query contains an exact
 * namespace matcher for the locked namespace. See
 * {@link validateNamespaceSelectorLockdown} in `selector-lockdown.ts` for the
 * full semantics (shared with the `loki_query` tool).
 */
export const validateNamespaceLockdown = validateNamespaceSelectorLockdown;

const MAX_RESULT_CHARS = 20_000;
const truncate = makeTruncate(MAX_RESULT_CHARS, 'use a shorter time range, coarser step, or more specific selector');

export interface PrometheusQueryParams {
  query: string;
  time?: string;
  start?: string;
  end?: string;
  step?: string;
}

/**
 * Execute a read-only Prometheus query and return the raw JSON response as a string.
 *
 * Validates required params for range queries before making the network call,
 * applies a request timeout, and caps output to avoid blowing the model's context.
 */
export async function runPrometheusQuery(
  queryType: 'instant' | 'range',
  params: PrometheusQueryParams,
  config: PrometheusConfig,
): Promise<string> {
  if (queryType === 'range') {
    if (!params.start) return 'Error: range queries require a start parameter (RFC3339 or Unix seconds).';
    if (!params.end) return 'Error: range queries require an end parameter (RFC3339 or Unix seconds).';
    if (!params.step) return 'Error: range queries require a step parameter (e.g. "15s", "1m").';
  }

  // Namespace lockdown: code-enforced when config.lockedNamespace is set.
  // The PromQL query must contain an exact namespace="<locked>" selector on
  // every vector selector — any selector that could match other namespaces
  // (or the absence of a selector) is rejected.
  if (config.lockedNamespace && !validateNamespaceLockdown(params.query, config.lockedNamespace)) {
    return (
      `${BLOCKED_PREFIX}namespace lockdown is active — queries must include ` +
      `namespace="${config.lockedNamespace}" in every vector selector. ` +
      `Example: 'up{namespace="${config.lockedNamespace}"}'`
    );
  }

  const endpoint = queryType === 'instant' ? '/api/v1/query' : '/api/v1/query_range';

  return runJsonQuery(config, endpoint, 'Prometheus', truncate, (searchParams) => {
    searchParams.set('query', params.query);
    if (queryType === 'instant') {
      if (params.time) searchParams.set('time', params.time);
    } else {
      searchParams.set('start', params.start!);
      searchParams.set('end', params.end!);
      searchParams.set('step', params.step!);
    }
  });
}
