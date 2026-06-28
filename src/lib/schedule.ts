/**
 * Pure helpers for Heimdall's schedule mode.
 *
 * No I/O — all functions are deterministic and unit-testable without a cluster.
 * Implements a minimal 5-field cron parser (minute hour dom month dow) in UTC,
 * covering *, step (STAR/n), specific values, ranges (a-b), and comma lists.
 */
import { formatDurationMs } from './duration.ts';

export interface ScheduledTriageConfig {
  /** Enable/disable the triage schedule. */
  enabled: boolean;
  /**
   * Standard 5-field UTC cron expression, e.g. "0 STAR/6 * * *" (every 6 h).
   * Fields: minute hour day-of-month month day-of-week.
   */
  cron: string;
  /** Optional namespace scope for the triage sweep. */
  namespace?: string | null;
  /** Sweep all namespaces (-A). */
  allNamespaces?: boolean | null;
}

/**
 * Check whether a cron field value matches a single cron field descriptor.
 *
 * Supported patterns:
 *   *        - always matches
 *   n        - exact value
 *   a-b      - inclusive range
 *   a-b/n    - range with step: values from a to b where (value - a) % n === 0
 *   n/s      - start-value with step: values >= n where (value - n) % s === 0
 *   STAR/n   - every nth value starting from lowerBound (e.g. dom/month fields start at 1)
 *   a,b,c    - comma-separated list of the above
 *
 * @param lowerBound  Start of the field's valid range (0 for minute/hour/dow, 1 for dom/month).
 */
export function matchesCronField(value: number, field: string, lowerBound = 0): boolean {
  // Comma-separated list — try each sub-field
  if (field.includes(',')) {
    return field.split(',').some((sub) => matchesCronField(value, sub.trim(), lowerBound));
  }

  if (field === '*') return true;

  // */n  — every nth value starting from lowerBound
  const stepMatch = field.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[1], 10);
    return step > 0 && (value - lowerBound) % step === 0;
  }

  // a-b/n  — range with step (must be tested before plain a-b to avoid partial match)
  const rangeStepMatch = field.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (rangeStepMatch) {
    const lo = parseInt(rangeStepMatch[1], 10);
    const hi = parseInt(rangeStepMatch[2], 10);
    const step = parseInt(rangeStepMatch[3], 10);
    return step > 0 && value >= lo && value <= hi && (value - lo) % step === 0;
  }

  // a-b  — inclusive range
  const rangeMatch = field.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const lo = parseInt(rangeMatch[1], 10);
    const hi = parseInt(rangeMatch[2], 10);
    return value >= lo && value <= hi;
  }

  // n/s  — start-value with step (e.g. 5/15 → 5, 20, 35, 50)
  const startStepMatch = field.match(/^(\d+)\/(\d+)$/);
  if (startStepMatch) {
    const start = parseInt(startStepMatch[1], 10);
    const step = parseInt(startStepMatch[2], 10);
    return step > 0 && value >= start && (value - start) % step === 0;
  }

  // Exact numeric value
  const num = parseInt(field, 10);
  return !isNaN(num) && value === num;
}

/**
 * Validate a single non-comma token from a cron field against the allowed range.
 * Exported for direct unit testing.
 * Returns an error string on violation, or undefined when valid.
 *
 * @param part  A single sub-expression (e.g. "*", "5", "1-5", "5/15", "1-10/2").
 * @param name  Human-readable field name used in error messages.
 * @param field The full original field string (used in error messages).
 * @param lo    Inclusive lower bound of the field's valid range.
 * @param hi    Inclusive upper bound of the field's valid range.
 */
export function validateCronPart(
  part: string,
  name: string,
  field: string,
  lo: number,
  hi: number,
): string | undefined {
  if (part === '*' || part.startsWith('*/')) return undefined;

  // a-b or a-b/n — validate range bounds and optional step
  const rangeM = part.match(/^(\d+)-(\d+)(\/(\d+))?$/);
  if (rangeM) {
    const a = parseInt(rangeM[1], 10);
    const b = parseInt(rangeM[2], 10);
    if (a > b || a < lo || b > hi) {
      return `${name} field "${field}" is out of range [${lo}-${hi}]`;
    }
    if (rangeM[4] !== undefined && parseInt(rangeM[4], 10) === 0) {
      return `${name} field "${field}" has an invalid step: step must be > 0`;
    }
    return undefined;
  }

  // n/s — start-value with step: validate starting value and step
  const startStepM = part.match(/^(\d+)\/(\d+)$/);
  if (startStepM) {
    const n = parseInt(startStepM[1], 10);
    const s = parseInt(startStepM[2], 10);
    if (n < lo || n > hi) {
      return `${name} field "${field}" is out of range [${lo}-${hi}]`;
    }
    if (s === 0) {
      return `${name} field "${field}" has an invalid step: step must be > 0`;
    }
    return undefined;
  }

  // Exact numeric value
  const n = parseInt(part, 10);
  if (isNaN(n) || n < lo || n > hi) {
    return `${name} field "${field}" is out of range [${lo}-${hi}]`;
  }
  return undefined;
}

/**
 * Validate a 5-field cron expression.
 * Returns an error message when invalid, or undefined when valid.
 */
export function validateCronExpression(cron: string): string | undefined {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    return `Expected 5 fields (minute hour dom month dow), got ${fields.length}`;
  }
  // day-of-week upper bound is 7 to allow Sunday alias
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  const lowerBounds = [0, 0, 1, 1, 0];
  const names = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'];
  for (let i = 0; i < 5; i++) {
    const f = fields[i];
    // Supports: *, */n, n, n-m, n/s, n-m/s and comma-separated combinations
    if (!/^(\*(\/\d+)?|\d+(-\d+)?(\/\d+)?)(,(\*(\/\d+)?|\d+(-\d+)?(\/\d+)?))*$/.test(f)) {
      return `Invalid ${names[i]} field: "${f}"`;
    }
    const [lo, hi] = ranges[i];
    const lb = lowerBounds[i];
    // Reject out-of-range tokens before checking for matches.
    for (const part of f.split(',')) {
      const err = validateCronPart(part, names[i], f, lo, hi);
      if (err) return err;
    }
    // Verify at least one value in the valid range matches (non-empty field).
    const hasMatch = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k).some((v) =>
      matchesCronField(v, f, lb),
    );
    if (!hasMatch) {
      return `${names[i]} field "${f}" matches no values in range [${lo}-${hi}]`;
    }
  }
  return undefined;
}

/**
 * Compute the next UTC time a 5-field cron expression fires after `from`.
 *
 * Pre-computes valid-value Sets for each field so the search loop uses O(1)
 * lookups instead of repeated regex calls — worst-case expressions (e.g. a
 * dom that never exists) complete in milliseconds instead of blocking the
 * event loop for seconds.
 *
 * Standard cron DOM/DOW semantics: when BOTH dom and dow are restricted (not
 * '*'), the expression fires when EITHER field matches (union/OR semantics,
 * as in POSIX/vixie-cron).  When one or both are '*', AND semantics apply.
 *
 * day-of-week value 7 is accepted as a Sunday alias (same as 0).
 *
 * @throws When no fire time is found within one year.
 */
function validFieldValues(length: number, start: number, field: string, lowerBound: number): Set<number> {
  return new Set(
    Array.from({ length }, (_, i) => i + start).filter((v) => matchesCronField(v, field, lowerBound)),
  );
}

export function nextFireTime(cronExpr: string, from: Date): Date {
  const [minuteField, hourField, domField, monthField, dowField] = cronExpr.trim().split(/\s+/);

  const validMinutes = validFieldValues(60, 0, minuteField, 0);
  const validHours = validFieldValues(24, 0, hourField, 0);
  const validDoms = validFieldValues(31, 1, domField, 1);
  const validMonths = validFieldValues(12, 1, monthField, 1);
  // dow=7 is a Sunday alias; map it to 0 before storing in the Set
  const validDows = new Set(
    Array.from({ length: 7 }, (_, i) => i).filter(
      (d) => matchesCronField(d, dowField, 0) || (d === 0 && matchesCronField(7, dowField, 0)),
    ),
  );

  // Standard cron: when both dom and dow are restricted, either matching fires (OR).
  const domRestricted = domField !== '*';
  const dowRestricted = dowField !== '*';

  // Advance to the start of the next minute (cron has no seconds field).
  const candidate = new Date(from);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  const limit = new Date(candidate);
  limit.setUTCFullYear(limit.getUTCFullYear() + 1);

  while (candidate < limit) {
    // Skip to the 1st of the next month when the current month doesn't match.
    // setUTCDate(1) first prevents JS date overflow (e.g. Jan 31 + month++ = Mar 3).
    if (!validMonths.has(candidate.getUTCMonth() + 1)) {
      candidate.setUTCDate(1);
      candidate.setUTCMonth(candidate.getUTCMonth() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    // Skip to midnight of the next day when neither DOM nor DOW matches.
    const domMatch = validDoms.has(candidate.getUTCDate());
    const dowMatch = validDows.has(candidate.getUTCDay());
    const dayMatch =
      domRestricted && dowRestricted
        ? domMatch || dowMatch  // both restricted → OR semantics (POSIX cron)
        : domMatch && dowMatch; // wildcard involved → AND semantics

    if (!dayMatch) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    // Skip to :00 of the next hour when the current hour doesn't match.
    if (!validHours.has(candidate.getUTCHours())) {
      candidate.setUTCHours(candidate.getUTCHours() + 1, 0, 0, 0);
      continue;
    }

    // Within a valid hour, advance minute by minute until we hit a match.
    if (validMinutes.has(candidate.getUTCMinutes())) {
      return new Date(candidate);
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  throw new Error(`Cron expression '${cronExpr}' produced no fires within one year`);
}

/**
 * Format a delay in milliseconds as a human-readable string, e.g. "5h 30m".
 */
export function formatDelay(ms: number): string {
  return formatDurationMs(ms);
}
