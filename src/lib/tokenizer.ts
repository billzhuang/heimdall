/**
 * Shared shell-like argument tokenizer used by kubectl, aws, and other CLI runners.
 *
 * Honors single quotes, double quotes, and backslash escapes.
 * If the first token matches `binaryName` (case-insensitive) it is stripped,
 * so callers can pass either `"kubectl get pods"` or `"get pods"`.
 */
export function tokenizeShellArgs(input: string, binaryName: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else if (ch === '\\' && i + 1 < input.length && (input[i + 1] === '"' || input[i + 1] === '\\')) {
        current += input[++i];
      } else current += ch;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasToken = true;
    } else if (ch === '"') {
      inDouble = true;
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

  if (tokens.length > 0 && tokens[0].toLowerCase() === binaryName.toLowerCase()) {
    tokens.shift();
  }
  return tokens;
}
