/**
 * Pure HTTP helpers for Prometheus query API access.
 *
 * Supports instant queries (/api/v1/query) and range queries (/api/v1/query_range).
 * The Prometheus base URL and timeout come from trusted config/env — never from
 * model-selected arguments.
 */
import { applyRedaction, type CompiledRedactionRule } from './regex-redact.ts';
import { makeTruncate } from './output-truncation.ts';
import { fetchWithTimeout } from './http.ts';

export interface PrometheusConfig {
  url: string;
  timeoutMs: number;
  /** User-configured regex redaction rules compiled at startup. */
  regexRedactionRules?: CompiledRedactionRule[];
}

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

  const endpoint = queryType === 'instant' ? '/api/v1/query' : '/api/v1/query_range';
  const searchParams = new URLSearchParams({ query: params.query });

  if (queryType === 'instant') {
    if (params.time) searchParams.set('time', params.time);
  } else {
    searchParams.set('start', params.start!);
    searchParams.set('end', params.end!);
    searchParams.set('step', params.step!);
  }

  try {
    // Build the request URL inside the try block so a malformed config.url
    // throws a TypeError that is caught and returned as a clean error string.
    const baseUrl = new URL(config.url);
    baseUrl.pathname = baseUrl.pathname.replace(/\/$/, '') + endpoint;
    searchParams.forEach((value, key) => baseUrl.searchParams.set(key, value));

    return await fetchWithTimeout(baseUrl.toString(), config.timeoutMs, async (response) => {
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const detail = body ? `: ${body.slice(0, 200)}` : '';
        return `Prometheus HTTP ${response.status} ${response.statusText}${detail}`;
      }
      const text = await response.text();
      return truncate(applyRedaction(text, config.regexRedactionRules ?? []));
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return `Prometheus query timed out after ${config.timeoutMs}ms.`;
    }
    return `Prometheus query failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
