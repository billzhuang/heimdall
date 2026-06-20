/**
 * Pure HTTP helpers for Grafana Loki log query API access.
 *
 * Only uses the read-only /loki/api/v1/query_range endpoint — never pushes
 * or deletes logs. The Loki base URL and timeout come from trusted config/env,
 * never from model-selected arguments.
 */
import { applyRedaction, type CompiledRedactionRule } from './regex-redact.ts';

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

/** Truncate output to avoid blowing the model's context window. */
function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS) +
    '\n\n[Output truncated — use a narrower time range, smaller limit, or more specific LogQL selector]'
  );
}

/** Parse a simple duration string (e.g. "1h", "30m", "2d") into milliseconds. */
function parseDurationMs(duration: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(duration);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * (multipliers[unit] ?? 0);
}

/**
 * Resolve a time expression to an ISO8601 string for the Loki API.
 *
 * - Relative (starting with '-'): subtract parsed duration from `nowMs`.
 *   Returns `expr` unchanged if the resulting timestamp is out of Date's range.
 * - Unix second epoch (all digits, ≤13 chars): convert to ISO8601 — Loki
 *   interprets bare integers as nanoseconds, so passing seconds unchanged
 *   would query around 1970 instead of the intended time.
 * - Everything else (ISO8601, RFC3339): passed through unchanged.
 */
export function resolveTime(expr: string, nowMs: number): string {
  if (expr.startsWith('-')) {
    const durationMs = parseDurationMs(expr.slice(1));
    if (durationMs !== null) {
      const ts = nowMs - durationMs;
      if (!Number.isFinite(ts)) return expr;
      const date = new Date(ts);
      if (Number.isNaN(date.getTime())) return expr;
      return date.toISOString();
    }
  }
  // Unix second epoch: all-digit string up to 13 chars (seconds, not ms/ns).
  // Convert to ISO8601 so Loki receives RFC3339, which it always interprets correctly.
  if (/^\d{1,13}$/.test(expr)) {
    return new Date(Number(expr) * 1000).toISOString();
  }
  return expr;
}

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const baseUrl = new URL(config.url);
    baseUrl.pathname = baseUrl.pathname.replace(/\/$/, '') + '/loki/api/v1/query_range';

    baseUrl.searchParams.set('query', params.query);
    baseUrl.searchParams.set('start', startResolved);
    baseUrl.searchParams.set('end', endResolved);
    baseUrl.searchParams.set('limit', String(effectiveLimit));
    baseUrl.searchParams.set('direction', params.direction ?? DEFAULT_DIRECTION);

    const response = await fetch(baseUrl.toString(), { signal: controller.signal });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const redactedBody = applyRedaction(body, config.regexRedactionRules ?? []);
      const detail = redactedBody ? `: ${redactedBody.slice(0, 200)}` : '';
      return `Loki HTTP ${response.status} ${response.statusText}${detail}`;
    }

    const text = await response.text();
    return truncate(applyRedaction(text, config.regexRedactionRules ?? []));
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return `Loki query timed out after ${config.timeoutMs}ms.`;
    }
    const message = err instanceof Error ? err.message : String(err);
    return `Loki query failed: ${applyRedaction(message, config.regexRedactionRules ?? [])}`;
  } finally {
    clearTimeout(timer);
  }
}
