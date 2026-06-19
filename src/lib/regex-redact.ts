/**
 * Configurable regex-based redaction for tool output.
 *
 * Applies user-defined patterns (from heimdall.config.yaml `redaction.rules`) to
 * any string before it is returned to the model. Each match is replaced with
 * `[REDACTED:<rule_name>]`. Patterns are compiled once at startup (not per-call).
 *
 * Distinct from `redact.ts`, which structurally redacts Kubernetes Secret
 * `.data`/`.stringData` fields. This layer handles general credential patterns
 * (API keys, bearer tokens, AWS keys, PEM headers, etc.) that may appear anywhere
 * in kubectl output or Prometheus label values.
 */

export interface RedactionRule {
  name: string;
  pattern: string;
}

export interface CompiledRedactionRule {
  name: string;
  re: RegExp;
}

/**
 * Extract a leading inline-flag group `(?flags)` from a pattern string.
 * Supports the JavaScript flag letters (g, i, m, s, u, y).
 * `(?i)` is common in Python/Java/Perl patterns; this strips it and applies
 * the equivalent JS flag so operator-supplied patterns work as expected.
 */
function extractInlineFlags(pattern: string): { pattern: string; extraFlags: string } {
  const m = pattern.match(/^\(\?([gimsuy]+)\)/);
  if (m) return { pattern: pattern.slice(m[0].length), extraFlags: m[1] };
  return { pattern, extraFlags: '' };
}

/**
 * Compile raw rule definitions into RegExp objects.
 * Invalid patterns are skipped with a console warning rather than crashing.
 * Leading inline flag groups (`(?i)`, `(?im)`, etc.) are extracted and
 * applied as JS regex flags so patterns copied from other languages work.
 */
export function compileRules(rules: RedactionRule[]): CompiledRedactionRule[] {
  const compiled: CompiledRedactionRule[] = [];
  for (const rule of rules) {
    const { pattern, extraFlags } = extractInlineFlags(rule.pattern);
    const flags = 'g' + extraFlags.replace('g', ''); // always global; avoid duplicate g
    try {
      compiled.push({ name: rule.name, re: new RegExp(pattern, flags) });
    } catch {
      console.warn(`[heimdall] Skipping invalid redaction rule "${rule.name}": pattern "${rule.pattern}" is not a valid regex`);
    }
  }
  return compiled;
}

/**
 * Apply compiled redaction rules to a text string.
 * Each match is replaced by `[REDACTED:<rule_name>]`.
 * The global-flag regex lastIndex is reset before each use so the function is safe to call repeatedly.
 */
export function applyRedaction(text: string, rules: CompiledRedactionRule[]): string {
  if (!rules.length || !text) return text;
  let result = text;
  for (const { name, re } of rules) {
    re.lastIndex = 0;
    result = result.replace(re, `[REDACTED:${name}]`);
  }
  return result;
}
