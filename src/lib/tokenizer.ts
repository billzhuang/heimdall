/**
 * Result shape shared by every CLI safety module's command-validation
 * function (kubectl, aws, cdk): allow/deny with a human-readable reason,
 * plus the raw command and parsed subcommand for logging/audit.
 */
export interface CommandValidationResult {
  allowed: boolean;
  reason: string;
  command: string;
  subcommand: string | null;
}

/**
 * Shared shell-like argument tokenizer used by kubectl, aws, and other CLI runners.
 *
 * Honors single quotes, double quotes, and backslash escapes.
 * If `binaryName` is provided and the first token matches it (case-insensitive)
 * it is stripped, so callers can pass either `"kubectl get pods"` or `"get pods"`.
 * Omit `binaryName` to keep all tokens (e.g. when the validator needs the binary
 * name present to confirm it is the right CLI).
 */
export function tokenizeShellArgs(input: string, binaryName?: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoteChar: '"' | "'" | null = null;
  let hasToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quoteChar !== null) {
      if (ch === quoteChar) {
        quoteChar = null;
      } else if (quoteChar === '"' && ch === '\\') {
        const next = input[i + 1];
        // In double-quote mode only `\"` and `\\` are recognized escapes; all
        // other backslash sequences preserve the literal backslash.
        if (next === '"' || next === '\\') {
          current += input[++i];
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quoteChar = ch;
      hasToken = true;
    } else if (ch === '\\' && i + 1 < input.length) {
      current += input[++i];
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(current);

  if (binaryName !== undefined && tokens.length > 0 && tokens[0].toLowerCase() === binaryName.toLowerCase()) {
    tokens.shift();
  }
  return tokens;
}

/**
 * Quote a single argv token for display/validation purposes, matching POSIX
 * shell single-quoting: wraps in `'...'` and escapes embedded single quotes
 * as `'\''`. Only applied when the token contains whitespace, a quote, a
 * backslash, or is empty (an unquoted empty token would otherwise vanish
 * when the result is joined and re-split) — plain tokens are left bare for
 * readability.
 */
function quoteShellArg(arg: string): string {
  if (arg === '') return "''";
  return /[\s'"\\]/.test(arg) ? `'${arg.replace(/'/g, "'\\''")}'` : arg;
}

/**
 * Rebuild a display/validation command string from a binary name and argv,
 * shell-quoting any token that needs it. Used to reconstruct the string form
 * that string-based validators (and audit logs) expect from already-tokenized
 * argv, so validation and execution stay in sync with what actually runs.
 */
export function buildShellCommand(bin: string, argv: string[]): string {
  if (argv.length === 0) return bin;
  return `${bin} ${argv.map(quoteShellArg).join(' ')}`;
}

/**
 * Return the index of the first non-option token in `parts` at or after
 * `startIndex`, skipping option flags and consuming the value token that
 * follows any flag present in `optionsWithValue`.
 * Returns -1 when no such token exists.
 */
export function findNextNonOptionToken(
  parts: string[],
  startIndex: number,
  optionsWithValue: ReadonlySet<string>,
): number {
  let skipNext = false;
  for (let i = startIndex; i < parts.length; i++) {
    const part = parts[i];
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (part.startsWith('-')) {
      if (!part.includes('=') && optionsWithValue.has(part)) {
        skipNext = true;
      }
      continue;
    }
    return i;
  }
  return -1;
}
