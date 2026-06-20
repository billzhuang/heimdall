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
