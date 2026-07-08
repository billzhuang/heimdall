/**
 * Shared config resolution helpers used by tool factory functions.
 */
import * as v from 'valibot';

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

/**
 * Resolve a string config value with config → env → default precedence, the
 * pattern every observability tool factory uses for URLs and credentials.
 * `configValue` wins if truthy; otherwise the first truthy env var (checked in
 * order) wins; otherwise `fallback`.
 */
export function resolveConfigString(
  configValue: string | null | undefined,
  envVars: string | string[],
  fallback = '',
): string {
  if (configValue) return configValue;
  for (const name of Array.isArray(envVars) ? envVars : [envVars]) {
    const value = process.env[name];
    if (value) return value;
  }
  return fallback;
}

/**
 * Build the " NAMESPACE LOCKDOWN ACTIVE: ..." suffix appended to a tool's
 * description when namespace lockdown is configured. Returns '' when
 * `lockedNamespace` is not set. `message` is only invoked when locked, so it
 * can build its wording from the narrowed (non-nullish) namespace value.
 */
export function buildLockdownNote(
  lockedNamespace: string | null | undefined,
  message: (namespace: string) => string,
): string {
  return lockedNamespace ? ` NAMESPACE LOCKDOWN ACTIVE: ${message(lockedNamespace)}` : '';
}

/**
 * Build the valibot input schema for a tool that accepts a single free-form
 * `args` string covering everything after the binary name — the shape shared
 * by `aws_cli` and `cdk_query`. `bin` is the lowercase binary name (e.g.
 * "aws"); its uppercase form is used as the CLI's display label.
 */
export function buildArgsInputSchema(bin: string) {
  return v.object({
    args: v.pipe(
      v.string(),
      v.description(`Arguments passed to the ${bin.toUpperCase()} CLI, excluding the leading "${bin}".`),
    ),
  });
}
