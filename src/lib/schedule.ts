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

/** Structural form of a single non-comma cron sub-expression (see {@link parseCronPart}). */
type CronPartAst =
  | { readonly kind: 'wildcard' }
  | { readonly kind: 'step'; readonly step: number }
  | { readonly kind: 'range'; readonly lo: number; readonly hi: number }
  | { readonly kind: 'rangeStep'; readonly lo: number; readonly hi: number; readonly step: number }
  | { readonly kind: 'startStep'; readonly start: number; readonly step: number }
  | { readonly kind: 'exact'; readonly value: number };

const CRON_STEP_RE = /^\*\/(\d+)$/;
const CRON_RANGE_STEP_RE = /^(\d+)-(\d+)\/(\d+)$/;
const CRON_RANGE_RE = /^(\d+)-(\d+)$/;
const CRON_START_STEP_RE = /^(\d+)\/(\d+)$/;

/**
 * Parse a single non-comma cron sub-expression into its structural form.
 *
 * Shared by matchesCronField (matching) and validateCronPart (bounds checking)
 * so both recognize exactly the same syntax:
 *   *        - wildcard
 *   STAR/n   - every nth value starting from the field's lower bound
 *   a-b/n    - range with step (checked before plain a-b to avoid partial match)
 *   a-b      - inclusive range
 *   n/s      - start-value with step (e.g. 5/15 → 5, 20, 35, 50)
 *   n        - exact value
 *
 * Returns undefined when `part` matches none of the above (including a bare
 * non-numeric token).
 */
function parseCronPart(part: string): CronPartAst | undefined {
  if (part === '*') return { kind: 'wildcard' };

  const stepMatch = part.match(CRON_STEP_RE);
  if (stepMatch) return { kind: 'step', step: parseInt(stepMatch[1], 10) };

  const rangeStepMatch = part.match(CRON_RANGE_STEP_RE);
  if (rangeStepMatch) {
    return {
      kind: 'rangeStep',
      lo: parseInt(rangeStepMatch[1], 10),
      hi: parseInt(rangeStepMatch[2], 10),
      step: parseInt(rangeStepMatch[3], 10),
    };
  }

  const rangeMatch = part.match(CRON_RANGE_RE);
  if (rangeMatch) {
    return { kind: 'range', lo: parseInt(rangeMatch[1], 10), hi: parseInt(rangeMatch[2], 10) };
  }

  const startStepMatch = part.match(CRON_START_STEP_RE);
  if (startStepMatch) {
    return { kind: 'startStep', start: parseInt(startStepMatch[1], 10), step: parseInt(startStepMatch[2], 10) };
  }

  const num = parseInt(part, 10);
  return isNaN(num) ? undefined : { kind: 'exact', value: num };
}

/**
 * Check whether a cron field value matches a single cron field descriptor.
 *
 * Supported patterns: see {@link parseCronPart}; `a,b,c` comma-separated lists
 * of the above are also supported.
 *
 * @param lowerBound  Start of the field's valid range (0 for minute/hour/dow, 1 for dom/month).
 */
export function matchesCronField(value: number, field: string, lowerBound = 0): boolean {
  // Comma-separated list — try each sub-field
  if (field.includes(',')) {
    return field.split(',').some((sub) => matchesCronField(value, sub.trim(), lowerBound));
  }

  const ast = parseCronPart(field);
  if (!ast) return false;

  switch (ast.kind) {
    case 'wildcard':
      return true;
    case 'step':
      return ast.step > 0 && (value - lowerBound) % ast.step === 0;
    case 'rangeStep':
      return ast.step > 0 && value >= ast.lo && value <= ast.hi && (value - ast.lo) % ast.step === 0;
    case 'range':
      return value >= ast.lo && value <= ast.hi;
    case 'startStep':
      return ast.step > 0 && value >= ast.start && (value - ast.start) % ast.step === 0;
    case 'exact':
      return value === ast.value;
  }
}

function outOfRangeError(name: string, field: string, lo: number, hi: number): string {
  return `${name} field "${field}" is out of range [${lo}-${hi}]`;
}

function stepZeroError(name: string, field: string): string {
  return `${name} field "${field}" has an invalid step: step must be > 0`;
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
  // Wildcard and step forms are never bounds-checked (even */0 passes here —
  // validateCronExpression's separate hasMatch scan is what rejects */0).
  // The 'wildcard'/'step' switch cases below are unreachable in practice but
  // kept for exhaustiveness; don't add step>0 validation there believing it
  // will run.
  if (part === '*' || part.startsWith('*/')) return undefined;

  const ast = parseCronPart(part);
  if (!ast) return outOfRangeError(name, field, lo, hi);

  switch (ast.kind) {
    case 'wildcard':
    case 'step':
      return undefined;
    case 'rangeStep':
      if (ast.lo > ast.hi || ast.lo < lo || ast.hi > hi) return outOfRangeError(name, field, lo, hi);
      return ast.step === 0 ? stepZeroError(name, field) : undefined;
    case 'range':
      return ast.lo > ast.hi || ast.lo < lo || ast.hi > hi ? outOfRangeError(name, field, lo, hi) : undefined;
    case 'startStep':
      if (ast.start < lo || ast.start > hi) return outOfRangeError(name, field, lo, hi);
      return ast.step === 0 ? stepZeroError(name, field) : undefined;
    case 'exact':
      return ast.value < lo || ast.value > hi ? outOfRangeError(name, field, lo, hi) : undefined;
  }
}

/** Per-field metadata for cron validation. day-of-week upper bound is 7 (Sunday alias). */
const CRON_FIELDS = [
  { name: 'minute',       lo: 0, hi: 59, lb: 0 },
  { name: 'hour',         lo: 0, hi: 23, lb: 0 },
  { name: 'day-of-month', lo: 1, hi: 31, lb: 1 },
  { name: 'month',        lo: 1, hi: 12, lb: 1 },
  { name: 'day-of-week',  lo: 0, hi:  7, lb: 0 },
] as const;

/**
 * Validate a 5-field cron expression.
 * Returns an error message when invalid, or undefined when valid.
 */
export function validateCronExpression(cron: string): string | undefined {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    return `Expected 5 fields (minute hour dom month dow), got ${fields.length}`;
  }
  for (const [i, { name, lo, hi, lb }] of CRON_FIELDS.entries()) {
    const f = fields[i];
    // Supports: *, */n, n, n-m, n/s, n-m/s and comma-separated combinations
    if (!/^(\*(\/\d+)?|\d+(-\d+)?(\/\d+)?)(,(\*(\/\d+)?|\d+(-\d+)?(\/\d+)?))*$/.test(f)) {
      return `Invalid ${name} field: "${f}"`;
    }
    // Reject out-of-range tokens before checking for matches.
    for (const part of f.split(',')) {
      const err = validateCronPart(part, name, f, lo, hi);
      if (err) return err;
    }
    // Verify at least one value in the valid range matches (non-empty field).
    const hasMatch = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k).some((v) =>
      matchesCronField(v, f, lb),
    );
    if (!hasMatch) {
      return `${name} field "${f}" matches no values in range [${lo}-${hi}]`;
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
