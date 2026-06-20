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
}

const MAX_RESULT_CHARS = 20_000;

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
 * Relative expressions (starting with '-') are converted to absolute timestamps
 * by subtracting the parsed duration from `nowMs`. Absolute ISO8601 timestamps
 * and Unix second strings are passed through unchanged.
 */
export function resolveTime(expr: string, nowMs: number): string {
  if (expr.startsWith('-')) {
    const durationMs = parseDurationMs(expr.slice(1));
    if (durationMs !== null) {
      return new Date(nowMs - durationMs).toISOString();
    }
  }
  return expr;
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
 * Validates required params, applies a request timeout, truncates output, and
 * applies regex redaction rules before returning to the model.
 */
export async function runLokiQuery(params: LokiQueryParams, config: LokiConfig): Promise<string> {
  if (!params.query.trim()) {
    return 'Error: query must be a non-empty LogQL expression (e.g. \'{namespace="prod"} |= "ERROR"\').';
  }

  const nowMs = Date.now();
  const startResolved = resolveTime(params.start ?? '-1h', nowMs);
  const endResolved = resolveTime(params.end ?? new Date(nowMs).toISOString(), nowMs);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const baseUrl = new URL(config.url);
    baseUrl.pathname = baseUrl.pathname.replace(/\/$/, '') + '/loki/api/v1/query_range';

    baseUrl.searchParams.set('query', params.query);
    baseUrl.searchParams.set('start', startResolved);
    baseUrl.searchParams.set('end', endResolved);
    baseUrl.searchParams.set('limit', String(params.limit ?? DEFAULT_LIMIT));
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
