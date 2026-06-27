/**
 * Shared shell-like argument tokenizer used by kubectl, aws, cdk, and other CLI runners.
 *
 * Honors single quotes, double quotes, and backslash escapes.
 * `tokenize` returns all tokens as-is; `tokenizeShellArgs` additionally strips a
 * leading binary name so callers can pass either `"kubectl get pods"` or `"get pods"`.
 */

/**
 * Tokenize a shell-like command string into individual arguments.
 *
 * - Single-quoted strings: no escape processing; `'` terminates the string.
 * - Double-quoted strings: only `\"` and `\\` are recognized escapes; all other
 *   backslash sequences preserve the literal backslash.
 * - Outside quotes: `\<ch>` produces `<ch>` (backslash escape).
 * - Unclosed quotes: the remaining input is consumed as the current token.
 */
export function tokenize(input: string): string[] {
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
  return tokens;
}

/**
 * Tokenize shell-like args, stripping a leading binary name if present.
 *
 * If the first token matches `binaryName` (case-insensitive) it is stripped,
 * so callers can pass either `"kubectl get pods"` or `"get pods"`.
 */
export function tokenizeShellArgs(input: string, binaryName: string): string[] {
  const tokens = tokenize(input);
  if (tokens.length > 0 && tokens[0].toLowerCase() === binaryName.toLowerCase()) {
    tokens.shift();
  }
  return tokens;
}
