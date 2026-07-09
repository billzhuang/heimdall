/**
 * Shared CLI argument-validation helpers used by the mode entry points
 * (triage-mode.ts, watch-mode.ts, ...) when hand-rolling flag parsing.
 */
import { fileURLToPath } from 'node:url';
import { resolveModel } from './model.ts';
import { getMessage, getStackOrMessage } from './error-utils.ts';

/**
 * True when this module was invoked directly as the process entry point
 * (`node file.js`), false when it was imported by another module (including
 * a test file). Pass the importing module's `import.meta.url`.
 */
export function isMainModule(importMetaUrl: string): boolean {
  return fileURLToPath(importMetaUrl) === process.argv[1];
}

/** Write "Error: <msg>" to stderr and exit(code). Shared by every stderr+exit(1) guard below. */
export function die(msg: string, code = 1): never {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(code);
}

/** Write an error to stderr and exit(1) when the next CLI token is missing or looks like a flag. */
export function requireNextArg(args: string[], i: number, msg: string): void {
  if (!args[i + 1] || args[i + 1].startsWith('-')) {
    die(msg);
  }
}

/** Write an error to stderr and exit(1) when value is empty. */
export function requireNonEmptyValue(value: string, msg: string): void {
  if (!value) {
    die(msg);
  }
}

/**
 * Parse a comma-separated CLI list value: trims whitespace, drops empty
 * tokens, and dedupes. Writes an error to stderr and exit(1) with `emptyMsg`
 * when nothing survives the filtering.
 */
export function parseCommaSeparatedList(raw: string, emptyMsg: string): string[] {
  const parsed = raw.split(',').map((v) => v.trim()).filter(Boolean);
  if (parsed.length === 0) {
    die(emptyMsg);
  }
  return Array.from(new Set(parsed));
}

/**
 * Parse a `--model <value>` / `-m <value>` / `--model=<value>` style flag at
 * `args[i]`. Call only when the caller has already matched `args[i]` against
 * one of `aliases` or the `--model=` prefix. Writes an error to stderr and
 * exit(1) when the value is missing or empty, matching `requireNextArg` /
 * `requireNonEmptyValue`.
 *
 * Returns the parsed value and the loop index to resume from (`i` unchanged
 * for the `=` form, `i + 1` after consuming the following token).
 */
export function parseModelFlag(
  args: string[],
  i: number,
  aliases: string[] = ['--model'],
): { value: string; nextIndex: number } {
  const arg = args[i];
  if (aliases.includes(arg)) {
    requireNextArg(args, i, `${arg} requires a value`);
    return { value: args[i + 1], nextIndex: i + 1 };
  }
  const value = arg.slice('--model='.length);
  requireNonEmptyValue(value, '--model= requires a non-empty value');
  return { value, nextIndex: i };
}

/**
 * Parse a required `--flag <value>` / `--flag=<value>` style CLI flag at
 * `args[i]`. Call only when the caller has already matched `args[i]` against
 * the flag's aliases or the `equalsPrefix` (e.g. `--namespace=`). Writes an
 * error to stderr and exit(1) when the value is missing (`spaceMissingMsg`)
 * or empty in the `=` form (`equalsEmptyMsg`).
 *
 * Returns the parsed value, the loop index to resume from (`i` unchanged for
 * the `=` form, `i + 1` after consuming the following token), and
 * `usedEquals` so callers whose downstream validation message differs by
 * form (e.g. list-parsing) can pick the right one.
 */
export function parseRequiredFlag(
  args: string[],
  i: number,
  equalsPrefix: string,
  spaceMissingMsg: string,
  equalsEmptyMsg: string,
): { value: string; nextIndex: number; usedEquals: boolean } {
  const arg = args[i];
  if (arg.startsWith(equalsPrefix)) {
    const value = arg.slice(equalsPrefix.length);
    requireNonEmptyValue(value, equalsEmptyMsg);
    return { value, nextIndex: i, usedEquals: true };
  }
  requireNextArg(args, i, spaceMissingMsg);
  return { value: args[i + 1], nextIndex: i + 1, usedEquals: false };
}

/**
 * Match `args[i]` against a `--long`/`-short` flag (space-separated value) or
 * a `--long=value` prefix. Returns `undefined` when `args[i]` matches neither
 * form, so callers can chain it onto the next `else if` in a hand-rolled
 * parsing loop unchanged — unlike `parseModelFlag`, a missing/empty value is
 * not an error here, it's just a non-match.
 *
 * Returns the parsed value and the loop index to resume from (`i` unchanged
 * for the `=` form, `i + 1` after consuming the following token).
 */
export function parseAliasedFlag(
  args: string[],
  i: number,
  long: string,
  short?: string,
): { value: string; nextIndex: number } | undefined {
  const arg = args[i];
  if ((arg === long || arg === short) && args[i + 1]) {
    return { value: args[i + 1], nextIndex: i + 1 };
  }
  if (arg.startsWith(`${long}=`)) {
    return { value: arg.slice(long.length + 1), nextIndex: i };
  }
  return undefined;
}

/**
 * Handle the trailing `-h`/`--help` vs. unknown-option branch shared by
 * several mode entry points' hand-rolled argv loops: print `helpText` to
 * stdout and exit(0) for `-h`/`--help`, otherwise print an "unknown option"
 * error to stderr and exit(1).
 */
export function handleHelpOrUnknownOption(arg: string, helpText: string): never {
  if (arg === '-h' || arg === '--help') {
    process.stdout.write(helpText);
    process.exit(0);
  } else {
    die(`unknown option: ${arg}`);
  }
}

/**
 * Resolve the effective model via `resolveModel`, writing an error to stderr
 * and exit(1) on an invalid specifier instead of throwing. Shared by the mode
 * entry points (alert-mode, eval-mode, triage-mode, watch-mode) that all
 * resolve a `--model` flag once at startup and treat an invalid value as a
 * fatal CLI error.
 */
export function resolveModelOrExit(cliFlag?: string): string {
  try {
    return resolveModel(cliFlag);
  } catch (err) {
    die(getMessage(err));
  }
}

/**
 * Attach the fatal-error handler shared by every mode entry point's
 * `isMainModule` dispatch block: on rejection, write `<prefix>: <stack or
 * message>` to stderr and exit(1). `prefix` carries the per-mode tag and
 * wording (e.g. `"[heimdall-triage] Fatal error"`) so each mode's existing
 * message text is unchanged. Returns the resulting promise so callers
 * (notably tests) can await completion instead of racing the microtask queue.
 */
export function runMainOrExit(promise: Promise<void>, prefix: string): Promise<void> {
  return promise.catch((err: unknown): void => {
    process.stderr.write(`${prefix}: ${getStackOrMessage(err)}\n`);
    process.exit(1);
  });
}
