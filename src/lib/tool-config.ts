/**
 * Shared config resolution helpers used by tool factory functions.
 */

/**
 * Resolve a timeout value from raw config input. Returns `rawTimeout` when it
 * is a positive finite number; falls back to `defaultMs` for null, undefined,
 * zero, negative, NaN, or Infinity.
 */
export function resolveTimeoutMs(
  rawTimeout: number | null | undefined,
  defaultMs: number,
): number {
  return typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
    ? rawTimeout
    : defaultMs;
}

/**
 * Clamp a raw limit value from config/model input to [1, maxLimit].
 * Falls back to `defaultLimit` when `rawLimit` is null, undefined, NaN, or
 * non-finite. Finite values are truncated to an integer and clamped, so
 * negatives and fractions below 1 resolve to 1 rather than `defaultLimit`.
 */
export function clampLimit(
  rawLimit: number | null | undefined,
  defaultLimit: number,
  maxLimit: number,
): number {
  return typeof rawLimit === 'number' && Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), maxLimit)
    : defaultLimit;
}
