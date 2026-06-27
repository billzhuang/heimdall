/**
 * Pure HTTP helpers for Grafana Loki log query API access.
 *
 * Only uses the read-only /loki/api/v1/query_range endpoint — never pushes
 * or deletes logs. The Loki base URL and timeout come from trusted config/env,
 * never from model-selected arguments.
 */
import { applyRedaction, type CompiledRedactionRule } from './regex-redact.ts';
import { makeTruncate } from './output-truncation.ts';
import { resolveTimePassthrough } from './time-resolution.ts';
import { fetchWithTimeout, readErrorDetail, formatQueryError } from './http.ts';

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
 * Check that a LogQL query contains an exact namespace selector matching the
 * locked namespace. Accepts namespace="<ns>" or namespace=~"<ns>" (exact-string
 * regex), rejecting selectors that could match other namespaces.
 */
export function validateNamespaceLockdown(query: string, lockedNamespace: string): boolean {
  const escaped = escapeRegExpLiteral(lockedNamespace);
  const exact = new RegExp(`namespace\\s*=\\s*"${escaped}"`);
  const regexExact = new RegExp(`namespace\\s*=~\\s*"${escaped}"`);
  return exact.test(query) || regexExact.test(query);
}

/** Escape a string for use as a literal inside a RegExp constructor. */
function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
        `BLOCKED: namespace lockdown is active — queries must include ` +
        `namespace="${config.lockedNamespace}" in the stream selector. ` +
        `Example: '{namespace="${config.lockedNamespace}", app="my-app"} |= "ERROR"'`
      );
    }
  }

  const nowMs = Date.now();
  const startResolved = resolveTime(params.start ?? '-1h', nowMs);
  const endResolved = resolveTime(params.end ?? new Date(nowMs).toISOString(), nowMs);

  // Clamp limit: guard against expensive Loki scans from unbounded values.
  const effectiveLimit =
    typeof params.limit === 'number' && Number.isFinite(params.limit)
      ? Math.min(Math.max(Math.trunc(params.limit), 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

  try {
    const baseUrl = new URL(config.url);
    baseUrl.pathname = baseUrl.pathname.replace(/\/$/, '') + '/loki/api/v1/query_range';

    baseUrl.searchParams.set('query', params.query);
    baseUrl.searchParams.set('start', startResolved);
    baseUrl.searchParams.set('end', endResolved);
    baseUrl.searchParams.set('limit', String(effectiveLimit));
    baseUrl.searchParams.set('direction', params.direction ?? DEFAULT_DIRECTION);

    const response = await fetchWithTimeout(baseUrl.toString(), config.timeoutMs);

    if (!response.ok) {
      const detail = await readErrorDetail(response, config.regexRedactionRules ?? []);
      return `Loki HTTP ${response.status} ${response.statusText}${detail}`;
    }

    const text = await response.text();
    return truncate(applyRedaction(text, config.regexRedactionRules ?? []));
  } catch (err) {
    return formatQueryError(err, 'Loki', config.timeoutMs, config.regexRedactionRules ?? []);
  }
}
