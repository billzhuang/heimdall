const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

type DurationUnit = keyof typeof UNIT_MS;

/** Coarse-to-fine unit order used by formatDurationMs. */
const UNITS_DESCENDING: DurationUnit[] = ['d', 'h', 'm', 's', 'ms'];

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
  return value * UNIT_MS[match[2] as DurationUnit];
}

/**
 * Format milliseconds as a compact human-readable duration string.
 *
 * Selects the coarsest unit that divides the value exactly, so the result is
 * always a whole-number string (e.g. "2h" not "120m").  Returns "0ms" for zero
 * or negative input.
 *
 * Examples: 86_400_000 → "1d", 3_600_000 → "1h", 60_000 → "1m",
 *           1_000 → "1s", 500 → "500ms".
 *
 * The output is guaranteed to round-trip through parseDurationMs:
 *   parseDurationMs(formatDurationMs(n)) === n  for all integer n ≥ 0.
 */
export function formatDurationMs(ms: number): string {
  if (ms <= 0) return '0ms';
  for (const unit of UNITS_DESCENDING) {
    const factor = UNIT_MS[unit];
    if (ms % factor === 0) return `${ms / factor}${unit}`;
  }
  // UNIT_MS.ms === 1, so the loop always terminates above — this is unreachable.
  /* c8 ignore next */
  return `${ms}ms`;
}
