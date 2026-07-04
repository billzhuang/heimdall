/**
 * Shared config resolution helpers for HTTP server bootstrap.
 *
 * Used by both serve-mode.ts (CLI entrypoint) and lambda-handler.ts (AWS
 * Lambda entrypoint) so the two entrypoints can never drift on precedence.
 */

/**
 * Resolve the Bearer auth token. The env var takes precedence over the
 * config file value whenever it is set at all (including empty/whitespace),
 * per `??` semantics — only an *unset* env var falls through to config. The
 * resolved value is then trimmed, with an empty/whitespace-only result
 * treated as absent (no auth).
 */
export function resolveApiKey(
  envApiKey: string | undefined,
  configApiKey: string | null | undefined,
): string | undefined {
  const rawApiKey = envApiKey ?? configApiKey;
  return rawApiKey && rawApiKey.trim() ? rawApiKey.trim() : undefined;
}

/** Resolve the metrics service name label: config file value wins over the OTEL_SERVICE_NAME env var. */
export function resolveMetricsServiceName(
  configServiceName: string | null | undefined,
  envServiceName: string | undefined,
): string | undefined {
  return configServiceName?.trim() || envServiceName?.trim() || undefined;
}
