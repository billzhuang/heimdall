/**
 * Pure HTTP helpers for Jaeger / Grafana Tempo distributed trace query API.
 *
 * Only uses read-only GET endpoints — never writes or deletes traces. The base
 * URL and timeout come from trusted config/env, never from model-selected args.
 *
 * Both backends expose the Jaeger HTTP API at /api/traces, so a single
 * implementation covers both. Point `url` at either Jaeger Query (port 16686)
 * or Tempo (port 16686 via its Jaeger-compatible frontend).
 */
import type { CompiledRedactionRule } from './regex-redact.ts';
import { makeTruncate } from './output-truncation.ts';
import { resolveTimeUs } from './time-resolution.ts';
import { runJsonQuery } from './http.ts';
import { clampLimit } from './tool-config.ts';

export interface JaegerConfig {
  url: string;
  timeoutMs: number;
  regexRedactionRules?: CompiledRedactionRule[];
}

const MAX_RESULT_CHARS = 20_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const truncate = makeTruncate(MAX_RESULT_CHARS, 'use a smaller limit, narrower time range, or more specific service/operation filter');

/**
 * Resolve a time expression to Unix microseconds for the Jaeger /api/traces API.
 * See `resolveTimeUs` in time-resolution.ts for full semantics.
 */
export const resolveJaegerTimeUs = resolveTimeUs;

export interface JaegerQueryParams {
  service: string;
  operation?: string | null;
  start?: string | null;
  end?: string | null;
  limit?: number | null;
  minDuration?: string | null;
  tags?: string | null;
}

/**
 * Query the Jaeger HTTP API for recent distributed traces and return the raw
 * JSON response as a string.
 *
 * Validates required params, clamps limit, applies timeout, truncates output,
 * and applies regex redaction before returning to the model.
 */
export async function runJaegerQuery(params: JaegerQueryParams, config: JaegerConfig): Promise<string> {
  if (!params.service.trim()) {
    return 'Error: service must be a non-empty string (e.g. "checkout", "payments").';
  }

  const effectiveLimit = clampLimit(params.limit, DEFAULT_LIMIT, MAX_LIMIT);

  const nowMs = Date.now();

  return runJsonQuery(config, '/api/traces', 'Jaeger', truncate, (searchParams) => {
    searchParams.set('service', params.service.trim());
    searchParams.set('limit', String(effectiveLimit));

    if (params.operation) searchParams.set('operation', params.operation);
    if (params.minDuration) searchParams.set('minDuration', params.minDuration);
    if (params.tags) searchParams.set('tags', params.tags);

    if (params.start) {
      const startUs = resolveJaegerTimeUs(params.start, nowMs);
      if (startUs !== null) searchParams.set('start', String(startUs));
    }
    if (params.end) {
      const endUs = resolveJaegerTimeUs(params.end, nowMs);
      if (endUs !== null) searchParams.set('end', String(endUs));
    }
  });
}
