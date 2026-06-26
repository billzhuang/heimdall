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

/**
 * Format a millisecond duration into a compact human-readable string.
 *
 * Rounds to the nearest second, then breaks down into d/h/m/s components,
 * omitting zero-valued components. Returns "0s" for zero or sub-second inputs.
 *
 * Examples: 3_661_000 → "1h 1m 1s", 86_400_000 → "1d", 45_000 → "45s".
 */
export function formatDurationMs(ms: number): string {
  const totalSecs = Math.round(ms / 1_000);
  const days = Math.floor(totalSecs / 86_400);
  const hours = Math.floor((totalSecs % 86_400) / 3_600);
  const minutes = Math.floor((totalSecs % 3_600) / 60);
  const secs = totalSecs % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(' ');
}
