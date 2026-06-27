import { describe, it, expect } from 'vitest';
import {
  resolveTimeMs,
  resolveTimeSeconds,
  resolveTimeISO,
  resolveTimeUs,
  resolveTimePassthrough,
} from '../time-resolution.ts';

const NOW = new Date('2024-06-01T12:00:00Z').getTime(); // 1717243200000

// ---------------------------------------------------------------------------
// resolveTimeMs — core resolver
// ---------------------------------------------------------------------------

describe('resolveTimeMs', () => {
  it('subtracts hours for relative "-Xh" expressions', () => {
    expect(resolveTimeMs('-1h', NOW)).toBe(NOW - 3_600_000);
  });

  it('subtracts minutes for relative "-Xm" expressions', () => {
    expect(resolveTimeMs('-30m', NOW)).toBe(NOW - 30 * 60_000);
  });

  it('subtracts days for relative "-Xd" expressions', () => {
    expect(resolveTimeMs('-2d', NOW)).toBe(NOW - 2 * 86_400_000);
  });

  it('subtracts seconds for relative "-Xs" expressions', () => {
    expect(resolveTimeMs('-60s', NOW)).toBe(NOW - 60_000);
  });

  it('converts 10-digit Unix second string to milliseconds', () => {
    expect(resolveTimeMs('1717243200', NOW)).toBe(1717243200 * 1_000);
  });

  it('treats 11-digit string as Unix milliseconds', () => {
    expect(resolveTimeMs('10000000000', NOW)).toBe(10000000000);
  });

  it('treats 13-digit string as Unix milliseconds', () => {
    expect(resolveTimeMs('1717243200000', NOW)).toBe(1717243200000);
  });

  it('parses ISO8601 string to milliseconds', () => {
    expect(resolveTimeMs('2024-06-01T12:00:00Z', NOW)).toBe(NOW);
  });

  it('returns null for an unknown relative duration unit', () => {
    expect(resolveTimeMs('-5y', NOW)).toBeNull();
  });

  it('returns null for a completely unparseable string', () => {
    expect(resolveTimeMs('not-a-date', NOW)).toBeNull();
  });

  it('returns null when relative timestamp overflows to Infinity', () => {
    expect(resolveTimeMs('-1h', Infinity)).toBeNull();
  });

  it('returns null when relative timestamp is finite but exceeds Date range', () => {
    expect(resolveTimeMs('-999999999999d', NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveTimeSeconds — Unix seconds output
// ---------------------------------------------------------------------------

describe('resolveTimeSeconds', () => {
  it('returns floor(ms/1000) for relative expressions', () => {
    expect(resolveTimeSeconds('-1h', NOW)).toBe(Math.floor((NOW - 3_600_000) / 1_000));
  });

  it('converts 10-digit Unix second string correctly', () => {
    expect(resolveTimeSeconds('1717243200', NOW)).toBe(1717243200);
  });

  it('converts 13-digit Unix millisecond string to seconds', () => {
    expect(resolveTimeSeconds('1717243200000', NOW)).toBe(1717243200);
  });

  it('parses ISO8601 to Unix seconds', () => {
    expect(resolveTimeSeconds('2024-06-01T12:00:00Z', NOW)).toBe(1717243200);
  });

  it('returns null for an unknown duration unit', () => {
    expect(resolveTimeSeconds('-5y', NOW)).toBeNull();
  });

  it('returns null for an unparseable string', () => {
    expect(resolveTimeSeconds('not-a-date', NOW)).toBeNull();
  });

  it('returns null when nowMs is Infinity', () => {
    expect(resolveTimeSeconds('-1h', Infinity)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveTimeISO — ISO8601 string output
// ---------------------------------------------------------------------------

describe('resolveTimeISO', () => {
  it('converts relative "-1h" to ISO8601', () => {
    expect(resolveTimeISO('-1h', NOW)).toBe('2024-06-01T11:00:00.000Z');
  });

  it('converts 10-digit Unix second string to ISO8601', () => {
    expect(resolveTimeISO('1717243200', NOW)).toBe('2024-06-01T12:00:00.000Z');
  });

  it('converts 13-digit Unix millisecond string to ISO8601', () => {
    expect(resolveTimeISO('1717243200000', NOW)).toBe('2024-06-01T12:00:00.000Z');
  });

  it('passes through valid ISO8601 strings unchanged', () => {
    const iso = '2024-06-01T00:00:00Z';
    expect(resolveTimeISO(iso, NOW)).toBe(iso);
  });

  it('returns null for an unknown duration unit', () => {
    expect(resolveTimeISO('-5y', NOW)).toBeNull();
  });

  it('returns null for an unparseable string', () => {
    expect(resolveTimeISO('not-a-date', NOW)).toBeNull();
  });

  it('returns null when nowMs is Infinity', () => {
    expect(resolveTimeISO('-1h', Infinity)).toBeNull();
  });

  it('returns null when relative timestamp is finite but exceeds Date range', () => {
    expect(resolveTimeISO('-999999999999d', NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveTimeUs — Unix microseconds output
// ---------------------------------------------------------------------------

describe('resolveTimeUs', () => {
  it('converts relative "-1h" to microseconds', () => {
    const expectedMs = NOW - 3_600_000;
    expect(resolveTimeUs('-1h', NOW)).toBe(expectedMs * 1_000);
  });

  it('converts 10-digit Unix second string to microseconds', () => {
    expect(resolveTimeUs('1717243200', NOW)).toBe(1717243200 * 1_000_000);
  });

  it('converts 13-digit Unix millisecond string to microseconds', () => {
    expect(resolveTimeUs('1717243200000', NOW)).toBe(1717243200000 * 1_000);
  });

  it('converts 11-digit Unix millisecond string to microseconds', () => {
    expect(resolveTimeUs('10000000000', NOW)).toBe(10000000000 * 1_000);
  });

  it('converts ISO8601 to microseconds', () => {
    expect(resolveTimeUs('2024-06-01T12:00:00Z', NOW)).toBe(NOW * 1_000);
  });

  it('returns null for an unknown duration unit', () => {
    expect(resolveTimeUs('-5y', NOW)).toBeNull();
  });

  it('returns null for an unparseable string', () => {
    expect(resolveTimeUs('yesterday', NOW)).toBeNull();
  });

  it('returns null when the computed timestamp overflows', () => {
    const hugeNum = '1' + '0'.repeat(400);
    expect(resolveTimeUs(`-${hugeNum}d`, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveTimePassthrough — Loki variant (returns expr on failure)
// ---------------------------------------------------------------------------

describe('resolveTimePassthrough', () => {
  it('converts relative "-1h" to ISO8601', () => {
    expect(resolveTimePassthrough('-1h', NOW)).toBe('2024-06-01T11:00:00.000Z');
  });

  it('converts relative "-30m" to ISO8601', () => {
    expect(resolveTimePassthrough('-30m', NOW)).toBe('2024-06-01T11:30:00.000Z');
  });

  it('converts relative "-60s" to ISO8601', () => {
    expect(resolveTimePassthrough('-60s', NOW)).toBe('2024-06-01T11:59:00.000Z');
  });

  it('returns expr unchanged for an unknown relative duration unit', () => {
    expect(resolveTimePassthrough('-5y', NOW)).toBe('-5y');
  });

  it('returns expr unchanged when relative timestamp overflows', () => {
    const hugeNum = '1' + '0'.repeat(400);
    const expr = `-${hugeNum}d`;
    expect(resolveTimePassthrough(expr, NOW)).toBe(expr);
  });

  it('treats 10-digit bare integer as Unix seconds → ISO8601', () => {
    expect(resolveTimePassthrough('1717243200', NOW)).toBe('2024-06-01T12:00:00.000Z');
  });

  it('treats all bare integers as Unix seconds (even 13-digit)', () => {
    // Unlike other resolvers, the Loki variant always multiplies by 1000,
    // so 13-digit "millisecond" strings are treated as seconds.
    expect(resolveTimePassthrough('0', NOW)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('returns expr unchanged when bare integer × 1000 exceeds Date range', () => {
    // 9999999999999 seconds × 1000 = ~year 318857, outside ±8.64e15 ms Date range
    expect(resolveTimePassthrough('9999999999999', NOW)).toBe('9999999999999');
  });

  it('treats 13-digit ms epoch as seconds — intentional Loki divergence', () => {
    // Other resolvers treat 13-digit strings as Unix ms; this one always treats
    // them as Unix seconds (Loki interprets bare ints as nanoseconds, so all
    // bare ints must be converted from seconds before sending to Loki).
    // '1717243200000' as seconds → year ~56000, NOT 2024.
    const result = resolveTimePassthrough('1717243200000', NOW);
    expect(result).not.toBe('2024-06-01T12:00:00.000Z');
    expect(new Date(result).getFullYear()).toBeGreaterThan(50000);
  });

  it('passes through ISO8601 strings unchanged', () => {
    const iso = '2024-01-15T08:30:00Z';
    expect(resolveTimePassthrough(iso, NOW)).toBe(iso);
  });

  it('passes through arbitrary non-matching strings unchanged', () => {
    expect(resolveTimePassthrough('yesterday', NOW)).toBe('yesterday');
  });
});
