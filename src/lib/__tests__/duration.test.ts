import { describe, it, expect } from 'vitest';
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

describe('formatDurationMs', () => {
  it('formats zero as "0s"', () => {
    expect(formatDurationMs(0)).toBe('0s');
  });

  it('formats sub-second values as "0s" (rounds down)', () => {
    expect(formatDurationMs(499)).toBe('0s');
  });

  it('rounds 500ms up to 1s', () => {
    expect(formatDurationMs(500)).toBe('1s');
  });

  it('formats exact seconds', () => {
    expect(formatDurationMs(1_000)).toBe('1s');
    expect(formatDurationMs(45_000)).toBe('45s');
    expect(formatDurationMs(59_000)).toBe('59s');
  });

  it('formats exact minutes', () => {
    expect(formatDurationMs(60_000)).toBe('1m');
    expect(formatDurationMs(30 * 60_000)).toBe('30m');
  });

  it('formats minutes and seconds', () => {
    expect(formatDurationMs(90_000)).toBe('1m 30s');
    expect(formatDurationMs(2 * 60_000 + 15_000)).toBe('2m 15s');
  });

  it('formats exact hours', () => {
    expect(formatDurationMs(3_600_000)).toBe('1h');
    expect(formatDurationMs(2 * 3_600_000)).toBe('2h');
  });

  it('formats hours and minutes', () => {
    expect(formatDurationMs(5 * 3_600_000 + 30 * 60_000)).toBe('5h 30m');
  });

  it('formats hours and seconds (no minutes)', () => {
    expect(formatDurationMs(3_600_000 + 45_000)).toBe('1h 45s');
  });

  it('formats hours, minutes, and seconds', () => {
    expect(formatDurationMs(3_661_000)).toBe('1h 1m 1s');
  });

  it('formats exact days', () => {
    expect(formatDurationMs(86_400_000)).toBe('1d');
    expect(formatDurationMs(7 * 86_400_000)).toBe('7d');
  });

  it('formats days and hours', () => {
    expect(formatDurationMs(86_400_000 + 3_600_000)).toBe('1d 1h');
  });

  it('formats days, hours, minutes, and seconds', () => {
    expect(formatDurationMs(86_400_000 + 3_661_000)).toBe('1d 1h 1m 1s');
  });

  it('rounds to nearest second before decomposing', () => {
    expect(formatDurationMs(1_500)).toBe('2s');
    expect(formatDurationMs(1_499)).toBe('1s');
    expect(formatDurationMs(59_500)).toBe('1m');
  });

  it('is the round-trip inverse of parseDurationMs for whole-unit inputs', () => {
    const cases: [string, number][] = [
      ['1s', 1_000],
      ['30s', 30_000],
      ['1m', 60_000],
      ['2h', 7_200_000],
      ['1d', 86_400_000],
    ];
    for (const [str, _ms] of cases) {
      expect(formatDurationMs(parseDurationMs(str)!)).toBe(str);
    }
  });

  it('handles large values without overflow', () => {
    expect(formatDurationMs(365 * 86_400_000)).toBe('365d');
  });
});
