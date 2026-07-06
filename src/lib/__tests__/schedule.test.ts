import { describe, it, expect } from 'vitest';
import { matchesCronField, nextFireTime, validateCronExpression, validateCronPart, validateCronPartAst } from '../schedule.ts';

describe('matchesCronField', () => {
  it('* always matches', () => {
    expect(matchesCronField(0, '*')).toBe(true);
    expect(matchesCronField(59, '*')).toBe(true);
  });

  it('exact value matches only that value', () => {
    expect(matchesCronField(6, '6')).toBe(true);
    expect(matchesCronField(7, '6')).toBe(false);
  });

  it('*/n matches values divisible by n (lowerBound=0 default)', () => {
    expect(matchesCronField(0, '*/6')).toBe(true);
    expect(matchesCronField(6, '*/6')).toBe(true);
    expect(matchesCronField(12, '*/6')).toBe(true);
    expect(matchesCronField(3, '*/6')).toBe(false);
    expect(matchesCronField(0, '*/30')).toBe(true);
    expect(matchesCronField(30, '*/30')).toBe(true);
    expect(matchesCronField(15, '*/30')).toBe(false);
  });

  it('*/n respects lowerBound for dom/month fields', () => {
    // day-of-month lowerBound=1: */3 → 1, 4, 7, 10, ...
    expect(matchesCronField(1, '*/3', 1)).toBe(true);
    expect(matchesCronField(4, '*/3', 1)).toBe(true);
    expect(matchesCronField(7, '*/3', 1)).toBe(true);
    expect(matchesCronField(2, '*/3', 1)).toBe(false);
    expect(matchesCronField(3, '*/3', 1)).toBe(false);
    // month lowerBound=1: */6 → 1, 7 (Jan, Jul)
    expect(matchesCronField(1, '*/6', 1)).toBe(true);
    expect(matchesCronField(7, '*/6', 1)).toBe(true);
    expect(matchesCronField(6, '*/6', 1)).toBe(false);
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

  it('*/0 step always returns false (step must be > 0)', () => {
    expect(matchesCronField(0, '*/0')).toBe(false);
    expect(matchesCronField(1, '*/0')).toBe(false);
    expect(matchesCronField(60, '*/0')).toBe(false);
  });

  it('returns false for an unparseable field', () => {
    expect(matchesCronField(0, 'abc')).toBe(false);
  });

  it('comma list mixing exact and step patterns', () => {
    expect(matchesCronField(1, '1,*/10')).toBe(true);
    expect(matchesCronField(10, '1,*/10')).toBe(true);
    expect(matchesCronField(20, '1,*/10')).toBe(true);
    expect(matchesCronField(2, '1,*/10')).toBe(false);
  });

  it('comma list mixing range and exact patterns', () => {
    // "1-3,7" → matches 1, 2, 3, 7
    expect(matchesCronField(2, '1-3,7')).toBe(true);
    expect(matchesCronField(7, '1-3,7')).toBe(true);
    expect(matchesCronField(4, '1-3,7')).toBe(false);
  });

  it('a-b/n range-with-step matches values in range at given stride', () => {
    // 0-12/2 → 0, 2, 4, 6, 8, 10, 12
    expect(matchesCronField(0, '0-12/2')).toBe(true);
    expect(matchesCronField(2, '0-12/2')).toBe(true);
    expect(matchesCronField(12, '0-12/2')).toBe(true);
    expect(matchesCronField(1, '0-12/2')).toBe(false);   // odd — not on stride
    expect(matchesCronField(13, '0-12/2')).toBe(false);  // out of range
  });

  it('a-b/n with lowerBound=1 (dom/month) fires at correct stride within range', () => {
    // 3-15/4 (dom): 3, 7, 11, 15
    expect(matchesCronField(3, '3-15/4', 1)).toBe(true);
    expect(matchesCronField(7, '3-15/4', 1)).toBe(true);
    expect(matchesCronField(11, '3-15/4', 1)).toBe(true);
    expect(matchesCronField(15, '3-15/4', 1)).toBe(true);
    expect(matchesCronField(4, '3-15/4', 1)).toBe(false);
    expect(matchesCronField(16, '3-15/4', 1)).toBe(false);
  });

  it('a-b/0 range-with-step=0 always returns false', () => {
    expect(matchesCronField(0, '0-23/0')).toBe(false);
    expect(matchesCronField(6, '0-23/0')).toBe(false);
  });

  it('n/s start-value-with-step matches values from n in strides of s', () => {
    // 5/15 → 5, 20, 35, 50
    expect(matchesCronField(5, '5/15')).toBe(true);
    expect(matchesCronField(20, '5/15')).toBe(true);
    expect(matchesCronField(35, '5/15')).toBe(true);
    expect(matchesCronField(50, '5/15')).toBe(true);
    expect(matchesCronField(4, '5/15')).toBe(false);   // before start
    expect(matchesCronField(6, '5/15')).toBe(false);   // not on stride
  });

  it('n/s with n=0 behaves like */s from 0', () => {
    expect(matchesCronField(0, '0/10')).toBe(true);
    expect(matchesCronField(10, '0/10')).toBe(true);
    expect(matchesCronField(5, '0/10')).toBe(false);
  });

  it('n/0 start-with-step=0 always returns false', () => {
    expect(matchesCronField(5, '5/0')).toBe(false);
    expect(matchesCronField(0, '0/0')).toBe(false);
  });

  it('comma list mixing a-b/n and exact patterns', () => {
    // "0-12/3,30" → 0, 3, 6, 9, 12, 30
    expect(matchesCronField(0, '0-12/3,30')).toBe(true);
    expect(matchesCronField(6, '0-12/3,30')).toBe(true);
    expect(matchesCronField(30, '0-12/3,30')).toBe(true);
    expect(matchesCronField(1, '0-12/3,30')).toBe(false);
    expect(matchesCronField(13, '0-12/3,30')).toBe(false);
  });
});

describe('validateCronExpression', () => {
  it('accepts valid 5-field expressions', () => {
    expect(validateCronExpression('0 */6 * * *')).toBeUndefined();
    expect(validateCronExpression('*/30 * * * *')).toBeUndefined();
    expect(validateCronExpression('0 0 * * *')).toBeUndefined();
    expect(validateCronExpression('0 12 1 * *')).toBeUndefined();
  });

  it('accepts day-of-week 7 (Sunday alias)', () => {
    expect(validateCronExpression('0 9 * * 7')).toBeUndefined();
  });

  it('rejects wrong number of fields', () => {
    expect(validateCronExpression('* * * *')).toMatch(/5 fields/);
    expect(validateCronExpression('* * * * * *')).toMatch(/5 fields/);
  });

  it('rejects invalid field syntax', () => {
    expect(validateCronExpression('abc * * * *')).toMatch(/minute/);
  });

  it('rejects out-of-range numeric values', () => {
    expect(validateCronExpression('99 * * * *')).toMatch(/out of range/);
    expect(validateCronExpression('* 25 * * *')).toMatch(/out of range/);
  });

  it('rejects out-of-range ranges', () => {
    expect(validateCronExpression('58-99 * * * *')).toMatch(/out of range/);
  });

  it('rejects inverted range (lo > hi)', () => {
    expect(validateCronExpression('5-1 * * * *')).toMatch(/out of range/);
  });

  it('rejects day-of-month 0 (dom lower bound is 1)', () => {
    expect(validateCronExpression('0 0 0 * *')).toMatch(/out of range/);
  });

  it('rejects month 0 (month lower bound is 1)', () => {
    expect(validateCronExpression('0 0 1 0 *')).toMatch(/out of range/);
  });

  it('rejects month 13 (month upper bound is 12)', () => {
    expect(validateCronExpression('0 0 1 13 *')).toMatch(/out of range/);
  });

  it('rejects */0 step (matches no values)', () => {
    expect(validateCronExpression('*/0 * * * *')).toMatch(/matches no values/);
  });

  it('accepts comma-separated field values', () => {
    expect(validateCronExpression('0,30 * * * *')).toBeUndefined();
    expect(validateCronExpression('0 8,12,18 * * *')).toBeUndefined();
  });

  it('accepts range fields', () => {
    expect(validateCronExpression('0 9-17 * * *')).toBeUndefined();
    expect(validateCronExpression('0 0 1-15 * *')).toBeUndefined();
  });

  it('accepts a-b/n range-with-step fields', () => {
    expect(validateCronExpression('0 0-23/6 * * *')).toBeUndefined();  // every 6h in 0-23
    expect(validateCronExpression('0-59/15 * * * *')).toBeUndefined(); // every 15m in 0-59
    expect(validateCronExpression('0 0 1-31/7 * *')).toBeUndefined();  // every 7 days
  });

  it('rejects a-b/n when range bounds are out of range', () => {
    expect(validateCronExpression('0 0-25/2 * * *')).toMatch(/out of range/);  // hour hi=25 > 23
    expect(validateCronExpression('0-100/5 * * * *')).toMatch(/out of range/); // minute hi=100 > 59
  });

  it('rejects a-b/n when lo > hi (inverted range)', () => {
    expect(validateCronExpression('10-5/2 * * * *')).toMatch(/out of range/);
  });

  it('accepts n/s start-value-with-step fields', () => {
    expect(validateCronExpression('5/15 * * * *')).toBeUndefined();  // 5, 20, 35, 50
    expect(validateCronExpression('0 8/4 * * *')).toBeUndefined();   // 8, 12, 16, 20
  });

  it('rejects n/s when starting value is out of range', () => {
    expect(validateCronExpression('60/5 * * * *')).toMatch(/out of range/);   // minute 60 > 59
    expect(validateCronExpression('0 24/1 * * *')).toMatch(/out of range/);   // hour 24 > 23
  });

  it('rejects n/s with step=0 with a clear error message', () => {
    expect(validateCronExpression('5/0 * * * *')).toMatch(/step must be > 0/);
    expect(validateCronExpression('0 8/0 * * *')).toMatch(/step must be > 0/);
  });

  it('rejects a-b/n with step=0 with a clear error message', () => {
    expect(validateCronExpression('0-59/0 * * * *')).toMatch(/step must be > 0/);
    expect(validateCronExpression('0 0-23/0 * * *')).toMatch(/step must be > 0/);
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

  it('accepts day-of-week 7 as Sunday alias', () => {
    // 2024-01-14 is a Sunday (getUTCDay() === 0); dow=7 should fire on Sundays
    const from = new Date('2024-01-13T10:00:00Z'); // Saturday
    const next = nextFireTime('0 9 * * 7', from);
    expect(next.toISOString()).toBe('2024-01-14T09:00:00.000Z'); // next Sunday
  });

  it('uses OR semantics when both dom and dow are restricted', () => {
    // "0 9 1 * 1" fires on the 1st of every month OR every Monday, whichever comes first.
    // From 2024-01-01 (Monday, also the 1st), next occurrence after 09:00:
    // 2024-01-08 (Monday) comes before 2024-02-01.
    const from = new Date('2024-01-01T09:01:00Z');
    const next = nextFireTime('0 9 1 * 1', from);
    expect(next.toISOString()).toBe('2024-01-08T09:00:00.000Z'); // next Monday
  });

  it('crosses a year boundary when the cron only fires in January', () => {
    // "0 0 1 1 *" fires at midnight on January 1st.
    // From November 2024, next fire is January 1st 2025.
    const from = new Date('2024-11-15T10:00:00Z');
    const next = nextFireTime('0 0 1 1 *', from);
    expect(next.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('fires on a specific month and day (March 15)', () => {
    const from = new Date('2024-01-01T00:00:00Z');
    const next = nextFireTime('0 8 15 3 *', from);
    expect(next.toISOString()).toBe('2024-03-15T08:00:00.000Z');
  });

  it('fires on comma-separated minutes', () => {
    // "0,30 * * * *" fires at :00 and :30 of every hour
    const from = new Date('2024-01-15T10:25:00Z');
    const next = nextFireTime('0,30 * * * *', from);
    expect(next.toISOString()).toBe('2024-01-15T10:30:00.000Z');
  });

  it('fires with a range of hours (business hours)', () => {
    // "0 9-17 * * *" fires at :00 of every hour from 9-17
    const from = new Date('2024-01-15T10:30:00Z');
    const next = nextFireTime('0 9-17 * * *', from);
    expect(next.toISOString()).toBe('2024-01-15T11:00:00.000Z');
  });

  it('skips to the next in-range hour when current hour is outside range', () => {
    // After 17:00, next fire is 09:00 the following day
    const from = new Date('2024-01-15T18:00:00Z');
    const next = nextFireTime('0 9-17 * * *', from);
    expect(next.toISOString()).toBe('2024-01-16T09:00:00.000Z');
  });

  it('throws when expression never fires within a year', () => {
    // Feb 30 never exists — should throw
    expect(() => nextFireTime('0 0 30 2 *', new Date('2024-03-01T00:00:00Z'))).toThrow(
      /no fires within one year/,
    );
  });

  it('fires correctly with a-b/n range-with-step hour field', () => {
    // "0 0-23/6 * * *" → fires at 00:00, 06:00, 12:00, 18:00
    const from = new Date('2024-01-15T07:00:00Z');
    const next = nextFireTime('0 0-23/6 * * *', from);
    expect(next.toISOString()).toBe('2024-01-15T12:00:00.000Z');
  });

  it('fires correctly with a-b/n minute field', () => {
    // "0-59/15 * * * *" → fires at :00, :15, :30, :45 of every hour
    const from = new Date('2024-01-15T10:16:00Z');
    const next = nextFireTime('0-59/15 * * * *', from);
    expect(next.toISOString()).toBe('2024-01-15T10:30:00.000Z');
  });

  it('fires correctly with n/s start-value-with-step minute field', () => {
    // "5/15 * * * *" → fires at :05, :20, :35, :50 of every hour
    const from = new Date('2024-01-15T10:06:00Z');
    const next = nextFireTime('5/15 * * * *', from);
    expect(next.toISOString()).toBe('2024-01-15T10:20:00.000Z');
  });

  it('fires correctly with n/s hour field (start at 8, every 4 hours)', () => {
    // "0 8/4 * * *" → fires at 08:00, 12:00, 16:00, 20:00
    const from = new Date('2024-01-15T09:00:00Z');
    const next = nextFireTime('0 8/4 * * *', from);
    expect(next.toISOString()).toBe('2024-01-15T12:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// validateCronPart — direct tests of the extracted helper
// ---------------------------------------------------------------------------

describe('validateCronPart', () => {
  it('returns undefined for * wildcard', () => {
    expect(validateCronPart('*', 'minute', '*', 0, 59)).toBeUndefined();
  });

  it('returns undefined for */n step wildcard', () => {
    expect(validateCronPart('*/5', 'minute', '*/5', 0, 59)).toBeUndefined();
  });

  it('returns undefined for a valid exact value', () => {
    expect(validateCronPart('30', 'minute', '30', 0, 59)).toBeUndefined();
  });

  it('returns error when exact value is below lo', () => {
    const err = validateCronPart('0', 'day-of-month', '0', 1, 31);
    expect(err).toMatch(/out of range/);
  });

  it('returns error when exact value is above hi', () => {
    const err = validateCronPart('60', 'minute', '60', 0, 59);
    expect(err).toMatch(/out of range/);
  });

  it('returns error for NaN exact value', () => {
    const err = validateCronPart('abc', 'minute', 'abc', 0, 59);
    expect(err).toMatch(/out of range/);
  });

  it('returns undefined for a valid inclusive range', () => {
    expect(validateCronPart('1-12', 'month', '1-12', 1, 12)).toBeUndefined();
  });

  it('returns error when range lower bound is below lo', () => {
    const err = validateCronPart('0-5', 'day-of-month', '0-5', 1, 31);
    expect(err).toMatch(/out of range/);
  });

  it('returns error when range upper bound exceeds hi', () => {
    const err = validateCronPart('0-60', 'minute', '0-60', 0, 59);
    expect(err).toMatch(/out of range/);
  });

  it('returns error when range is inverted (lo > hi)', () => {
    const err = validateCronPart('5-1', 'minute', '5-1', 0, 59);
    expect(err).toMatch(/out of range/);
  });

  it('returns undefined for a valid range-with-step', () => {
    expect(validateCronPart('0-23/6', 'hour', '0-23/6', 0, 23)).toBeUndefined();
  });

  it('returns error for range-with-step=0', () => {
    const err = validateCronPart('0-59/0', 'minute', '0-59/0', 0, 59);
    expect(err).toMatch(/step must be > 0/);
  });

  it('returns undefined for a valid start-value-with-step', () => {
    expect(validateCronPart('5/15', 'minute', '5/15', 0, 59)).toBeUndefined();
  });

  it('returns error when start value of n/s is out of range', () => {
    const err = validateCronPart('60/5', 'minute', '60/5', 0, 59);
    expect(err).toMatch(/out of range/);
  });

  it('returns error for n/s with step=0', () => {
    const err = validateCronPart('5/0', 'minute', '5/0', 0, 59);
    expect(err).toMatch(/step must be > 0/);
  });

  it('includes the field name in the error message', () => {
    const err = validateCronPart('99', 'hour', '99', 0, 23);
    expect(err).toContain('hour');
    expect(err).toContain('"99"');
  });
});

// ---------------------------------------------------------------------------
// validateCronPartAst — direct tests of the AST-level helper
//
// validateCronPart's string-level guard for "*" / "*/n" means parseCronPart
// can never actually hand it a 'wildcard' or 'step' AST — so those switch
// cases are only reachable by calling validateCronPartAst directly with a
// synthetic AST, as done below.
// ---------------------------------------------------------------------------

describe('validateCronPartAst', () => {
  it('returns undefined for a wildcard AST', () => {
    expect(validateCronPartAst({ kind: 'wildcard' }, 'minute', '*', 0, 59)).toBeUndefined();
  });

  it('returns undefined for a step AST regardless of step value', () => {
    expect(validateCronPartAst({ kind: 'step', step: 0 }, 'minute', '*/0', 0, 59)).toBeUndefined();
    expect(validateCronPartAst({ kind: 'step', step: 5 }, 'minute', '*/5', 0, 59)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// nextFireTime skip-ahead paths
// ---------------------------------------------------------------------------

describe('nextFireTime skip-ahead optimisation', () => {
  it('skips directly to the next valid month (multi-month gap)', () => {
    // From May, "0 0 1 9 *" fires only in September — skip Jun, Jul, Aug entirely.
    const from = new Date('2024-05-20T12:00:00Z');
    const next = nextFireTime('0 0 1 9 *', from);
    expect(next.toISOString()).toBe('2024-09-01T00:00:00.000Z');
  });

  it('skips directly to the next valid hour (multi-hour gap)', () => {
    // From 03:30, "0 18 * * *" fires at 18:00 — skips 14.5 hours without per-minute iteration.
    const from = new Date('2024-03-10T03:30:00Z');
    const next = nextFireTime('0 18 * * *', from);
    expect(next.toISOString()).toBe('2024-03-10T18:00:00.000Z');
  });

  it('handles month-end to 1st-of-next-month without JS date overflow', () => {
    // Jan 31 + setUTCMonth(++) must not overflow into March.
    // "0 0 * 3 *" fires in March — skip Feb via Jan 31 as starting point.
    const from = new Date('2024-01-31T23:00:00Z');
    const next = nextFireTime('0 0 * 3 *', from);
    expect(next.toISOString()).toBe('2024-03-01T00:00:00.000Z');
  });

  it('skips invalid days and rolls to the next valid day', () => {
    // "0 9 15 * *" fires on the 15th — skip days 1-14 from Jan 1.
    const from = new Date('2024-01-01T00:00:00Z');
    const next = nextFireTime('0 9 15 * *', from);
    expect(next.toISOString()).toBe('2024-01-15T09:00:00.000Z');
  });
});
