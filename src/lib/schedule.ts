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
 *   *        — always matches
 *   n        — exact value
 *   a-b      — inclusive range
 *   STAR/n   — every nth value starting from lowerBound (e.g. dom/month fields start at 1)
 *   a,b,c    — comma-separated list of the above
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
      if (part === '*' || part.startsWith('*/')) continue;
      const rangeM = part.match(/^(\d+)-(\d+)$/);
      if (rangeM) {
        const a = parseInt(rangeM[1], 10);
        const b = parseInt(rangeM[2], 10);
        if (a > b || a < lo || b > hi) {
          return `${names[i]} field "${f}" is out of range [${lo}-${hi}]`;
        }
        continue;
      }
      const n = parseInt(part, 10);
      if (isNaN(n) || n < lo || n > hi) {
        return `${names[i]} field "${f}" is out of range [${lo}-${hi}]`;
      }
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
export function nextFireTime(cronExpr: string, from: Date): Date {
  const [minuteField, hourField, domField, monthField, dowField] = cronExpr.trim().split(/\s+/);

  const validMinutes = new Set(
    Array.from({ length: 60 }, (_, i) => i).filter((m) => matchesCronField(m, minuteField, 0)),
  );
  const validHours = new Set(
    Array.from({ length: 24 }, (_, i) => i).filter((h) => matchesCronField(h, hourField, 0)),
  );
  const validDoms = new Set(
    Array.from({ length: 31 }, (_, i) => i + 1).filter((d) => matchesCronField(d, domField, 1)),
  );
  const validMonths = new Set(
    Array.from({ length: 12 }, (_, i) => i + 1).filter((m) => matchesCronField(m, monthField, 1)),
  );
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
    const domMatch = validDoms.has(candidate.getUTCDate());
    const dowMatch = validDows.has(candidate.getUTCDay());
    const dayMatch =
      domRestricted && dowRestricted
        ? domMatch || dowMatch  // both restricted → OR semantics (POSIX cron)
        : domMatch && dowMatch; // wildcard involved → AND semantics

    if (
      validMonths.has(candidate.getUTCMonth() + 1) &&
      dayMatch &&
      validHours.has(candidate.getUTCHours()) &&
      validMinutes.has(candidate.getUTCMinutes())
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
  return formatDurationMs(ms);
}
