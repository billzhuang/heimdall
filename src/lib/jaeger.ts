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

export interface JaegerQueryParams {
  service: string;
  operation?: string | null;
  start?: string | null;
  end?: string | null;
  limit?: number | null;
  minDuration?: string | null;
  tags?: string | null;
}

function tagTokens(tags: string): string[] {
  return tags.trim().split(/\s+/).filter(Boolean);
}

function isMalformedTagToken(token: string): boolean {
  return token.indexOf('=') <= 0;
}

/**
 * Convert the tool's documented "key=value key2=value2" tag filter syntax into
 * the JSON-encoded object Jaeger's `/api/traces?tags=` actually expects (Jaeger's
 * query_parser.go unmarshals `tags` as JSON, not logfmt). Assumes `tags` has
 * already been validated (see `runJaegerQuery`) to contain no malformed tokens.
 */
export function parseTagsToJson(tags: string): string {
  const entries: Record<string, string> = Object.create(null);
  for (const pair of tagTokens(tags)) {
    if (isMalformedTagToken(pair)) continue;
    const eq = pair.indexOf('=');
    entries[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return JSON.stringify(entries);
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

  let tagsJson: string | undefined;
  if (params.tags && params.tags.trim()) {
    const malformed = tagTokens(params.tags).filter(isMalformedTagToken);
    if (malformed.length > 0) {
      return (
        'Error: tags must be one or more "key=value" pairs separated by spaces ' +
        `(e.g. "http.status_code=500 error=true"). Malformed token(s): ${malformed.join(', ')}.`
      );
    }
    tagsJson = parseTagsToJson(params.tags);
  }

  const effectiveLimit = clampLimit(params.limit, DEFAULT_LIMIT, MAX_LIMIT);

  const nowMs = Date.now();

  return runJsonQuery(config, '/api/traces', 'Jaeger', truncate, (searchParams) => {
    searchParams.set('service', params.service.trim());
    searchParams.set('limit', String(effectiveLimit));

    if (params.operation) searchParams.set('operation', params.operation);
    if (params.minDuration) searchParams.set('minDuration', params.minDuration);
    if (tagsJson) searchParams.set('tags', tagsJson);

    if (params.start) {
      const startUs = resolveTimeUs(params.start, nowMs);
      if (startUs !== null) searchParams.set('start', String(startUs));
    }
    if (params.end) {
      const endUs = resolveTimeUs(params.end, nowMs);
      if (endUs !== null) searchParams.set('end', String(endUs));
    }
  });
}
