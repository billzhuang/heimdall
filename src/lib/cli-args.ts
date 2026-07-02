/**
 * Shared CLI argument-validation helpers used by the mode entry points
 * (triage-mode.ts, watch-mode.ts, ...) when hand-rolling flag parsing.
 */

/** Write an error to stderr and exit(1) when the next CLI token is missing or looks like a flag. */
export function requireNextArg(args: string[], i: number, msg: string): void {
  if (!args[i + 1] || args[i + 1].startsWith('-')) {
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  }
}

/** Write an error to stderr and exit(1) when value is empty. */
export function requireNonEmptyValue(value: string, msg: string): void {
  if (!value) {
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  }
}
