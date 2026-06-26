const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

/**
 * Parse a simple duration string (e.g. "1h", "30m", "500ms", "2d") into milliseconds.
 * Returns null for unrecognised formats.
 *
 * Supported units: ms, s, m, h, d.
 */
export function parseDurationMs(duration: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(duration);
  if (!match) return null;
  const value = parseFloat(match[1]);
  // Regex guarantees match[2] is a valid UNIT_MS key — no fallback needed.
  return value * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}
