import { describe, it, expect } from 'vitest';
import { parseDurationMs } from '../duration.ts';

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
});
