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

/** A compiled, single-argument redaction function produced by {@link createRedactor}. */
export type Redactor = (text: string) => string;

/** Matches a single leading inline-flag group, e.g. `(?im)`. */
const INLINE_FLAG_RE = /^\(\?([gimsuy]+)\)/;

/**
 * Extract all leading inline-flag groups (e.g. `(?i)`, `(?im)`, `(?i)(?m)`)
 * from a pattern string. Supports the JavaScript flag letters (g, i, m, s, u, y).
 * Multiple consecutive groups like `(?i)(?m)SECRET` are fully consumed so the
 * resulting flags string is their union — patterns copied from Python/Java/Perl
 * that carry more than one flag group are handled correctly.
 */
function extractInlineFlags(pattern: string): { pattern: string; extraFlags: string } {
  let remaining = pattern;
  let allFlags = '';
  let flagMatch: RegExpMatchArray | null;
  while ((flagMatch = remaining.match(INLINE_FLAG_RE)) !== null) {
    allFlags += flagMatch[1];
    remaining = remaining.slice(flagMatch[0].length);
  }
  return { pattern: remaining, extraFlags: allFlags };
}

/**
 * Heuristic check for patterns that can cause catastrophic (exponential)
 * backtracking — e.g. `(a+)+` or `(.+)+`. Looks for a group that contains a
 * quantifier and is itself followed by a quantifier. Returns true when the
 * pattern is likely to be dangerous so callers can skip it.
 *
 * This is necessarily a heuristic: complex patterns like `(?:a|b)+` are safe
 * but would be flagged, while subtle hand-crafted patterns might slip through.
 * A false positive (skipping a legitimate rule) is always safer than hanging.
 */
function hasPotentialReDoS(pattern: string): boolean {
  // A group whose body contains + or * followed by a top-level + / * / {n,}
  return /\([^)]*[+*][^)]*\)[+*{]/.test(pattern);
}

/**
 * Deduplicate regex flags and strip the sticky flag `y`, which conflicts with
 * the global `g` flag required for exhaustive redaction (with `/gy`,
 * `String.prototype.replace` stops after the first non-contiguous match).
 */
function buildFlags(extraFlags: string, ruleName: string): string {
  const flagSet = new Set('g' + extraFlags);
  if (flagSet.has('y')) {
    flagSet.delete('y');
    console.warn(
      `[heimdall] Redaction rule "${ruleName}": sticky flag 'y' is incompatible with global redaction and has been removed`,
    );
  }
  return Array.from(flagSet).join('');
}

function warnSkip(ruleName: string, reason: string): void {
  console.warn(`[heimdall] Skipping redaction rule "${ruleName}": ${reason}`);
}

/**
 * Compile a single raw rule into a CompiledRedactionRule, or return null if the
 * rule should be skipped (invalid pattern, ReDoS risk, or empty after flag strip).
 * Logs a warning for every skipped rule.
 */
function compileSingleRule(rule: RedactionRule): CompiledRedactionRule | null {
  const { pattern, extraFlags } = extractInlineFlags(rule.pattern);
  if (!pattern) {
    warnSkip(rule.name, 'pattern is empty after stripping inline flags');
    return null;
  }
  if (hasPotentialReDoS(pattern)) {
    warnSkip(rule.name, `pattern "${rule.pattern}" may cause catastrophic backtracking`);
    return null;
  }
  const flags = buildFlags(extraFlags, rule.name);
  try {
    return { name: rule.name, re: new RegExp(pattern, flags) };
  } catch {
    warnSkip(rule.name, `pattern "${rule.pattern}" is not a valid regex`);
    return null;
  }
}

/**
 * Compile raw rule definitions into RegExp objects.
 * Invalid patterns are skipped with a console warning rather than crashing.
 * Leading inline flag groups (`(?i)`, `(?im)`, `(?i)(?m)`, etc.) are extracted
 * and applied as JS regex flags so patterns copied from other languages work,
 * including those carrying multiple separate flag groups.
 * Patterns with nested quantifiers (potential ReDoS) are also skipped.
 */
export function compileRules(rules: RedactionRule[]): CompiledRedactionRule[] {
  return rules.map(compileSingleRule).filter((r): r is CompiledRedactionRule => r !== null);
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

/**
 * Compile rules once and return a single-argument redaction function.
 * Prefer this over calling compileRules + applyRedaction separately when the
 * same rule set is applied to many strings — the rules are compiled exactly once.
 */
export function createRedactor(rules: RedactionRule[]): Redactor {
  const compiled = compileRules(rules);
  return (text: string) => applyRedaction(text, compiled);
}
