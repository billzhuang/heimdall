import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseDurationMs, formatDurationMs } from '../duration.ts';

describe('parseDurationMs', () => {
  it('parses milliseconds', () => {
    expect(parseDurationMs('500ms')).toBe(500);
    expect(parseDurationMs('1ms')).toBe(1);
  });

  it('parses seconds', () => {
    expect(parseDurationMs('1s')).toBe(1_000);
    expect(parseDurationMs('30s')).toBe(30_000);
  });

  it('parses minutes', () => {
    expect(parseDurationMs('1m')).toBe(60_000);
    expect(parseDurationMs('30m')).toBe(1_800_000);
  });

  it('parses hours', () => {
    expect(parseDurationMs('1h')).toBe(3_600_000);
    expect(parseDurationMs('2h')).toBe(7_200_000);
  });

  it('parses days', () => {
    expect(parseDurationMs('1d')).toBe(86_400_000);
    expect(parseDurationMs('7d')).toBe(604_800_000);
  });

  it('parses fractional values', () => {
    expect(parseDurationMs('1.5h')).toBe(5_400_000);
    expect(parseDurationMs('0.5m')).toBe(30_000);
  });

  it('returns null for empty string', () => {
    expect(parseDurationMs('')).toBeNull();
  });

  it('returns null for unknown unit', () => {
    expect(parseDurationMs('1w')).toBeNull();
    expect(parseDurationMs('1year')).toBeNull();
    expect(parseDurationMs('1min')).toBeNull();
  });

  it('returns null for non-numeric prefix', () => {
    expect(parseDurationMs('abc')).toBeNull();
    expect(parseDurationMs('xh')).toBeNull();
  });

  it('returns null for bare number without unit', () => {
    expect(parseDurationMs('100')).toBeNull();
  });

  it('returns null for negative values (not in format)', () => {
    expect(parseDurationMs('-1h')).toBeNull();
  });

  it('returns 0 for zero values', () => {
    expect(parseDurationMs('0ms')).toBe(0);
    expect(parseDurationMs('0s')).toBe(0);
    expect(parseDurationMs('0h')).toBe(0);
  });

  it('parses fractional seconds', () => {
    expect(parseDurationMs('0.5s')).toBe(500);
    expect(parseDurationMs('2.5s')).toBe(2_500);
  });

  it('parses fractional days', () => {
    expect(parseDurationMs('1.5d')).toBe(129_600_000);
    expect(parseDurationMs('0.5d')).toBe(43_200_000);
  });

  it('parses multi-digit millisecond values', () => {
    expect(parseDurationMs('100ms')).toBe(100);
    expect(parseDurationMs('1000ms')).toBe(1_000);
  });

  it('returns null for unit with missing numeric prefix', () => {
    expect(parseDurationMs('ms')).toBeNull();
    expect(parseDurationMs('h')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatDurationMs
// ---------------------------------------------------------------------------

describe('formatDurationMs', () => {
  it('returns "0ms" for zero', () => {
    expect(formatDurationMs(0)).toBe('0ms');
  });

  it('returns "0ms" for negative values', () => {
    expect(formatDurationMs(-1)).toBe('0ms');
    expect(formatDurationMs(-1000)).toBe('0ms');
  });

  it('formats whole milliseconds', () => {
    expect(formatDurationMs(1)).toBe('1ms');
    expect(formatDurationMs(500)).toBe('500ms');
    expect(formatDurationMs(999)).toBe('999ms');
  });

  it('formats whole seconds (prefers "s" over "ms")', () => {
    expect(formatDurationMs(1_000)).toBe('1s');
    expect(formatDurationMs(30_000)).toBe('30s');
    expect(formatDurationMs(90_000)).toBe('90s');
  });

  it('formats whole minutes (prefers "m" over "s")', () => {
    expect(formatDurationMs(60_000)).toBe('1m');
    expect(formatDurationMs(30 * 60_000)).toBe('30m');
  });

  it('formats whole hours (prefers "h" over "m")', () => {
    expect(formatDurationMs(3_600_000)).toBe('1h');
    expect(formatDurationMs(2 * 3_600_000)).toBe('2h');
  });

  it('formats whole days (prefers "d" over "h")', () => {
    expect(formatDurationMs(86_400_000)).toBe('1d');
    expect(formatDurationMs(7 * 86_400_000)).toBe('7d');
  });

  it('uses the coarsest exact unit (does not emit fractional units)', () => {
    // 90 000 ms = 90 s, not "1.5m"
    expect(formatDurationMs(90_000)).toBe('90s');
    // 1.5 h = 5 400 000 ms = 90 m
    expect(formatDurationMs(5_400_000)).toBe('90m');
    // 36 h = 129 600 000 ms (not divisible by 86 400 000)
    expect(formatDurationMs(36 * 3_600_000)).toBe('36h');
  });

  it('round-trips through parseDurationMs for all supported unit values', () => {
    const samples = [
      1, 500, 999, 1_000, 2_000, 59_000, 60_000, 61_000, 3_600_000, 7_200_000,
      86_400_000, 604_800_000,
    ];
    for (const ms of samples) {
      expect(parseDurationMs(formatDurationMs(ms))).toBe(ms);
    }
  });
});

// ---------------------------------------------------------------------------
// formatDurationMs — property-based round-trip
// ---------------------------------------------------------------------------

describe('formatDurationMs — property tests', () => {
  it('always round-trips through parseDurationMs for non-negative integers', () => {
    fc.assert(
      fc.property(
        // Restrict to non-negative integers up to 10 years in ms to keep tests fast.
        fc.integer({ min: 0, max: 10 * 365 * 86_400_000 }),
        (ms) => {
          const formatted = formatDurationMs(ms);
          const reparsed = parseDurationMs(formatted);
          if (ms <= 0) {
            expect(formatted).toBe('0ms');
            expect(reparsed).toBe(0);
          } else {
            expect(reparsed).toBe(ms);
          }
        },
      ),
    );
  });

  it('output always starts with a positive integer followed by a valid unit', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 * 365 * 86_400_000 }),
        (ms) => {
          const result = formatDurationMs(ms);
          expect(result).toMatch(/^\d+(ms|s|m|h|d)$/);
        },
      ),
    );
  });
});
