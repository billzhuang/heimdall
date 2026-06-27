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
import { applyRedaction, type CompiledRedactionRule } from './regex-redact.ts';
import { makeTruncate } from './output-truncation.ts';
import { resolveTimeUs } from './time-resolution.ts';

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

  const effectiveLimit =
    typeof params.limit === 'number' && Number.isFinite(params.limit)
      ? Math.min(Math.max(Math.trunc(params.limit), 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

  const nowMs = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const baseUrl = new URL(config.url);
    baseUrl.pathname = baseUrl.pathname.replace(/\/$/, '') + '/api/traces';

    baseUrl.searchParams.set('service', params.service.trim());
    baseUrl.searchParams.set('limit', String(effectiveLimit));

    if (params.operation) baseUrl.searchParams.set('operation', params.operation);
    if (params.minDuration) baseUrl.searchParams.set('minDuration', params.minDuration);
    if (params.tags) baseUrl.searchParams.set('tags', params.tags);

    if (params.start) {
      const startUs = resolveJaegerTimeUs(params.start, nowMs);
      if (startUs !== null) baseUrl.searchParams.set('start', String(startUs));
    }
    if (params.end) {
      const endUs = resolveJaegerTimeUs(params.end, nowMs);
      if (endUs !== null) baseUrl.searchParams.set('end', String(endUs));
    }

    const response = await fetch(baseUrl.toString(), { signal: controller.signal });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const redactedBody = applyRedaction(body, config.regexRedactionRules ?? []);
      const detail = redactedBody ? `: ${redactedBody.slice(0, 200)}` : '';
      return `Jaeger HTTP ${response.status} ${response.statusText}${detail}`;
    }

    const text = await response.text();
    return truncate(applyRedaction(text, config.regexRedactionRules ?? []));
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return `Jaeger query timed out after ${config.timeoutMs}ms.`;
    }
    const message = err instanceof Error ? err.message : String(err);
    return `Jaeger query failed: ${applyRedaction(message, config.regexRedactionRules ?? [])}`;
  } finally {
    clearTimeout(timer);
  }
}
