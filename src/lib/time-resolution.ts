/**
 * Shared time-expression resolver used by all observability backends.
 *
 * Accepts three input forms:
 *   - Relative: "-1h", "-30m", "-2d", "-60s"
 *   - Bare integer: Unix seconds (≤10 digits) or Unix milliseconds (11–13 digits)
 *   - ISO8601 / RFC3339: "2024-06-01T00:00:00Z"
 *
 * Each backend needs the result in a different unit; `resolveTimeMs` is the
 * common core and the named exports are thin wrappers.
 */
import { parseDurationMs } from './duration.ts';

const BARE_INT_RE = /^\d{1,13}$/;

/** Convert milliseconds to an ISO8601 string; returns null if the value is out of Date range. */
function msToIso(ms: number): string | null {
  try { return new Date(ms).toISOString(); } catch { return null; }
}

/** Format `ms` as ISO8601, falling back to `fallback` when `ms` is null or out of Date range. */
function formatMsOrFallback(ms: number | null, fallback: string): string {
  return ms === null ? fallback : (msToIso(ms) ?? fallback);
}

/**
 * Resolve a time expression to Unix milliseconds.
 *
 * - Relative (starting with '-'): subtract parsed duration from `nowMs`.
 * - Bare integer ≤10 digits: treated as Unix seconds → converted to ms.
 * - Bare integer 11–13 digits: treated as Unix milliseconds.
 * - ISO8601 / RFC3339: parsed by `Date.parse()`.
 * - Returns null on any parse failure.
 */
export function resolveTimeMs(expr: string, nowMs: number): number | null {
  if (expr.startsWith('-')) {
    const durationMs = parseDurationMs(expr.slice(1));
    if (durationMs === null) return null;
    const ts = nowMs - durationMs;
    if (!Number.isFinite(ts) || Math.abs(ts) > 8_640_000_000_000_000) return null;
    return ts;
  }
  if (BARE_INT_RE.test(expr)) {
    const n = Number(expr);
    return expr.length <= 10 ? n * 1_000 : n;
  }
  const ts = Date.parse(expr);
  if (!Number.isNaN(ts)) return ts;
  return null;
}

/**
 * Resolve a time expression to Unix seconds (integer).
 * Returns null when the expression cannot be parsed.
 */
export function resolveTimeSeconds(expr: string, nowMs: number): number | null {
  const ms = resolveTimeMs(expr, nowMs);
  return ms === null ? null : Math.floor(ms / 1_000);
}

/**
 * Resolve a time expression to an ISO8601 string.
 * ISO8601 input is passed through unchanged to preserve the original form.
 * Returns null when the expression cannot be parsed.
 */
export function resolveTimeISO(expr: string, nowMs: number): string | null {
  if (expr.startsWith('-') || BARE_INT_RE.test(expr)) {
    const ms = resolveTimeMs(expr, nowMs);
    return ms === null ? null : msToIso(ms);
  }
  // ISO8601 / RFC3339 — pass through unchanged if valid
  if (!Number.isNaN(Date.parse(expr))) return expr;
  return null;
}

/**
 * Resolve a time expression to Unix microseconds.
 * Returns null when the expression cannot be parsed.
 */
export function resolveTimeUs(expr: string, nowMs: number): number | null {
  const ms = resolveTimeMs(expr, nowMs);
  if (ms === null) return null;
  const us = ms * 1_000;
  return Number.isSafeInteger(us) ? us : null;
}

/**
 * Resolve a time expression to an ISO8601 string, returning the original
 * expression unchanged on any parse failure (Loki variant).
 *
 * Bare integers are always treated as Unix seconds regardless of digit count,
 * because Loki interprets bare integers as nanoseconds — passing them through
 * unchanged would query around 1970 instead of the intended time.
 */
export function resolveTimePassthrough(expr: string, nowMs: number): string {
  if (expr.startsWith('-')) {
    return formatMsOrFallback(resolveTimeMs(expr, nowMs), expr);
  }
  if (BARE_INT_RE.test(expr)) {
    return formatMsOrFallback(Number(expr) * 1_000, expr);
  }
  return expr;
}
