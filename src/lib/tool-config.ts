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
