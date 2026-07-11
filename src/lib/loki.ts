/**
 * Pure HTTP helpers for Grafana Loki log query API access.
 *
 * Only uses the read-only /loki/api/v1/query_range endpoint — never pushes
 * or deletes logs. The Loki base URL and timeout come from trusted config/env,
 * never from model-selected arguments.
 */
import type { CompiledRedactionRule } from './regex-redact.ts';
import { makeTruncate } from './output-truncation.ts';
import { resolveTimePassthrough } from './time-resolution.ts';
import { runJsonQuery } from './http.ts';
import { clampLimit } from './tool-config.ts';
import { escapeRegExpLiteral } from './regexp-utils.ts';
import { BLOCKED_PREFIX } from './harness.ts';

export interface LokiConfig {
  url: string;
  timeoutMs: number;
  /** User-configured regex redaction rules compiled at startup. */
  regexRedactionRules?: CompiledRedactionRule[];
  /** When set, all queries are rejected unless the LogQL selector includes namespace="<value>". */
  lockedNamespace?: string;
}

const MAX_RESULT_CHARS = 20_000;
const MAX_LIMIT = 5_000;
const truncate = makeTruncate(MAX_RESULT_CHARS, 'use a narrower time range, smaller limit, or more specific LogQL selector');

/**
 * Resolve a time expression to an ISO8601 string for the Loki API.
 * See `resolveTimePassthrough` in time-resolution.ts for full semantics.
 */
export const resolveTime = resolveTimePassthrough;

/**
 * Extract the LogQL stream selector — the leading `{...}` brace group — from
 * a query, ignoring braces inside quoted label values. Returns null if the
 * query has no selector or it's unterminated.
 */
function extractStreamSelector(query: string): string | null {
  const start = query.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inQuotes = false;
  for (let i = start; i < query.length; i++) {
    const ch = query[i];
    if (inQuotes) {
      if (ch === '\\') i++;
      else if (ch === '"') inQuotes = false;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return query.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Check that a LogQL query's stream selector contains an exact namespace
 * selector matching the locked namespace. Accepts namespace="<ns>" or
 * namespace=~"<ns>" (exact-string regex), rejecting selectors that could
 * match other namespaces.
 *
 * Only the stream selector itself is checked (not line filters or other
 * pipeline stages) — a raw string line filter like `|= \`namespace="prod"\``
 * must not be able to satisfy the lockdown while the real selector targets a
 * different namespace.
 */
export function validateNamespaceLockdown(query: string, lockedNamespace: string): boolean {
  const selector = extractStreamSelector(query);
  if (selector === null) return false;
  const escaped = escapeRegExpLiteral(lockedNamespace);
  const exact = new RegExp(`namespace\\s*=\\s*"${escaped}"`);
  const regexExact = new RegExp(`namespace\\s*=~\\s*"${escaped}"`);
  return exact.test(selector) || regexExact.test(selector);
}

export interface LokiQueryParams {
  query: string;
  start?: string | null;
  end?: string | null;
  limit?: number | null;
  direction?: 'forward' | 'backward';
}

const DEFAULT_LIMIT = 100;
const DEFAULT_DIRECTION = 'backward';

/**
 * Execute a read-only Loki log range query and return the raw JSON response as a string.
 *
 * Validates required params, enforces namespace lockdown when configured,
 * clamps the limit to MAX_LIMIT, applies a request timeout, truncates output,
 * and applies regex redaction rules before returning to the model.
 */
export async function runLokiQuery(params: LokiQueryParams, config: LokiConfig): Promise<string> {
  if (!params.query.trim()) {
    return 'Error: query must be a non-empty LogQL expression (e.g. \'{namespace="prod"} |= "ERROR"\').';
  }

  // Namespace lockdown: code-enforced when config.lockedNamespace is set.
  // The LogQL query must contain an exact namespace="<locked>" selector —
  // any selector that could match other namespaces is rejected.
  if (config.lockedNamespace) {
    if (!validateNamespaceLockdown(params.query, config.lockedNamespace)) {
      return (
        `${BLOCKED_PREFIX}namespace lockdown is active — queries must include ` +
        `namespace="${config.lockedNamespace}" in the stream selector. ` +
        `Example: '{namespace="${config.lockedNamespace}", app="my-app"} |= "ERROR"'`
      );
    }
  }

  const nowMs = Date.now();
  const startResolved = resolveTime(params.start ?? '-1h', nowMs);
  const endResolved = resolveTime(params.end ?? new Date(nowMs).toISOString(), nowMs);

  const effectiveLimit = clampLimit(params.limit, DEFAULT_LIMIT, MAX_LIMIT);

  return runJsonQuery(config, '/loki/api/v1/query_range', 'Loki', truncate, (searchParams) => {
    searchParams.set('query', params.query);
    searchParams.set('start', startResolved);
    searchParams.set('end', endResolved);
    searchParams.set('limit', String(effectiveLimit));
    searchParams.set('direction', params.direction ?? DEFAULT_DIRECTION);
  });
}
