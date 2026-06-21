import { describe, it, expect } from 'vitest';
import { matchesCronField, nextFireTime, validateCronExpression, formatDelay } from '../schedule.ts';

describe('matchesCronField', () => {
  it('* always matches', () => {
    expect(matchesCronField(0, '*')).toBe(true);
    expect(matchesCronField(59, '*')).toBe(true);
  });

  it('exact value matches only that value', () => {
    expect(matchesCronField(6, '6')).toBe(true);
    expect(matchesCronField(7, '6')).toBe(false);
  });

  it('*/n matches values divisible by n', () => {
    expect(matchesCronField(0, '*/6')).toBe(true);
    expect(matchesCronField(6, '*/6')).toBe(true);
    expect(matchesCronField(12, '*/6')).toBe(true);
    expect(matchesCronField(3, '*/6')).toBe(false);
    expect(matchesCronField(0, '*/30')).toBe(true);
    expect(matchesCronField(30, '*/30')).toBe(true);
    expect(matchesCronField(15, '*/30')).toBe(false);
  });

  it('range a-b matches inclusive', () => {
    expect(matchesCronField(1, '1-5')).toBe(true);
    expect(matchesCronField(5, '1-5')).toBe(true);
    expect(matchesCronField(6, '1-5')).toBe(false);
    expect(matchesCronField(0, '1-5')).toBe(false);
  });

  it('comma-separated list matches any element', () => {
    expect(matchesCronField(1, '1,3,5')).toBe(true);
    expect(matchesCronField(3, '1,3,5')).toBe(true);
    expect(matchesCronField(2, '1,3,5')).toBe(false);
  });
});

describe('validateCronExpression', () => {
  it('accepts valid 5-field expressions', () => {
    expect(validateCronExpression('0 */6 * * *')).toBeUndefined();
    expect(validateCronExpression('*/30 * * * *')).toBeUndefined();
    expect(validateCronExpression('0 0 * * *')).toBeUndefined();
    expect(validateCronExpression('0 12 1 * *')).toBeUndefined();
  });

  it('rejects wrong number of fields', () => {
    expect(validateCronExpression('* * * *')).toMatch(/5 fields/);
    expect(validateCronExpression('* * * * * *')).toMatch(/5 fields/);
  });

  it('rejects invalid field syntax', () => {
    expect(validateCronExpression('abc * * * *')).toMatch(/minute/);
  });
});

describe('nextFireTime', () => {
  it('fires at the next matching minute', () => {
    const from = new Date('2024-01-15T05:30:00Z');
    // Cron: 0 */6 * * * → fires at :00 of hours 0,6,12,18
    const next = nextFireTime('0 */6 * * *', from);
    expect(next.toISOString()).toBe('2024-01-15T06:00:00.000Z');
  });

  it('fires at midnight', () => {
    const from = new Date('2024-01-15T10:00:00Z');
    const next = nextFireTime('0 0 * * *', from);
    expect(next.toISOString()).toBe('2024-01-16T00:00:00.000Z');
  });

  it('fires every 30 minutes', () => {
    const from = new Date('2024-01-15T10:25:00Z');
    const next = nextFireTime('*/30 * * * *', from);
    expect(next.toISOString()).toBe('2024-01-15T10:30:00.000Z');
  });

  it('fires every minute', () => {
    const from = new Date('2024-01-15T10:25:30Z');
    const next = nextFireTime('* * * * *', from);
    expect(next.toISOString()).toBe('2024-01-15T10:26:00.000Z');
  });

  it('skips to next day when daily cron already passed today', () => {
    const from = new Date('2024-01-15T00:01:00Z');
    const next = nextFireTime('0 0 * * *', from);
    expect(next.toISOString()).toBe('2024-01-16T00:00:00.000Z');
  });

  it('advances from the current second (not inclusive of from minute)', () => {
    // from is exactly on a fire time — should advance to the NEXT fire
    const from = new Date('2024-01-15T06:00:00Z');
    const next = nextFireTime('0 */6 * * *', from);
    expect(next.toISOString()).toBe('2024-01-15T12:00:00.000Z');
  });
});

describe('formatDelay', () => {
  it('formats hours and minutes', () => {
    expect(formatDelay(5 * 3600_000 + 30 * 60_000)).toBe('5h 30m');
  });

  it('formats seconds only', () => {
    expect(formatDelay(45_000)).toBe('45s');
  });

  it('formats just minutes', () => {
    expect(formatDelay(10 * 60_000)).toBe('10m');
  });

  it('returns 0s for zero', () => {
    expect(formatDelay(0)).toBe('0s');
  });
});
