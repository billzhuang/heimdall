/**
 * Pure helpers for Heimdall's schedule mode.
 *
 * No I/O — all functions are deterministic and unit-testable without a cluster.
 * Implements a minimal 5-field cron parser (minute hour dom month dow) in UTC,
 * covering *, step (STAR/n), specific values, ranges (a-b), and comma lists.
 */

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
 *   *        — always matches
 *   n        — exact value
 *   a-b      — inclusive range
 *   STAR/n   — every nth value (divisible by n, starting from 0)
 *   a,b,c    — comma-separated list of the above
 */
export function matchesCronField(value: number, field: string): boolean {
  // Comma-separated list — try each sub-field
  if (field.includes(',')) {
    return field.split(',').some((sub) => matchesCronField(value, sub.trim()));
  }

  if (field === '*') return true;

  // */n  — every nth value
  const stepMatch = field.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[1], 10);
    return step > 0 && value % step === 0;
  }

  // a-b  — inclusive range
  const rangeMatch = field.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const lo = parseInt(rangeMatch[1], 10);
    const hi = parseInt(rangeMatch[2], 10);
    return value >= lo && value <= hi;
  }

  // Exact numeric value
  const num = parseInt(field, 10);
  return !isNaN(num) && value === num;
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
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  const names = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'];
  for (let i = 0; i < 5; i++) {
    // Test the field against a sample value — if it neither errors nor returns
    // a valid boolean for the field boundaries, the pattern is unrecognised.
    const f = fields[i];
    if (!/^(\*|(\*\/\d+)|(\d+(-\d+)?)(,(\d+(-\d+)?))*)+$/.test(f)) {
      return `Invalid ${names[i]} field: "${f}"`;
    }
    const [lo, hi] = ranges[i];
    // Verify at least one value in the valid range matches (non-empty field).
    const hasMatch = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k).some((v) =>
      matchesCronField(v, f),
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
 * Searches minute-by-minute for up to one year.  For the schedules Heimdall
 * uses (every few hours / once a day) this is at most a few hundred iterations.
 *
 * @throws When no fire time is found within one year.
 */
export function nextFireTime(cronExpr: string, from: Date): Date {
  const [minuteField, hourField, domField, monthField, dowField] = cronExpr.trim().split(/\s+/);

  // Advance to the start of the next minute (cron has no seconds field).
  const candidate = new Date(from);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  const limit = new Date(candidate);
  limit.setUTCFullYear(limit.getUTCFullYear() + 1);

  while (candidate < limit) {
    if (
      matchesCronField(candidate.getUTCMonth() + 1, monthField) &&
      matchesCronField(candidate.getUTCDate(), domField) &&
      matchesCronField(candidate.getUTCDay(), dowField) &&
      matchesCronField(candidate.getUTCHours(), hourField) &&
      matchesCronField(candidate.getUTCMinutes(), minuteField)
    ) {
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
  const totalSecs = Math.round(ms / 1000);
  const hours = Math.floor(totalSecs / 3600);
  const minutes = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(' ');
}
