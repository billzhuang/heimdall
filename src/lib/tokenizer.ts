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
 * Rebuild a shell-safe display string from a binary name and its argv, quoting
 * any argument that contains whitespace or a quote/backslash character. This is
 * the inverse of `tokenizeShellArgs` and is used to build the `cmd` string
 * passed to the safety validator and audit log, so validation and logging
 * always agree on the exact argv that will execute.
 */
export function joinShellArgs(binaryName: string, argv: string[]): string {
  const quoted = argv.map((a) => (a === '' || /[\s'"\\]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a));
  return [binaryName, ...quoted].join(' ');
}
