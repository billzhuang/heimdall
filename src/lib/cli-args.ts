/**
 * Shared CLI argument-validation helpers used by the mode entry points
 * (triage-mode.ts, watch-mode.ts, ...) when hand-rolling flag parsing.
 */
import { fileURLToPath } from 'node:url';
import { resolveModel } from './model.ts';
import { getMessage } from './error-utils.ts';

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
