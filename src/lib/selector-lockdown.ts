/**
 * Namespace-lockdown enforcement for query languages built on Prometheus-style
 * label selectors — `{label="value", label2=~"value2"}` — which both PromQL
 * and LogQL use for their stream/vector selectors. Shared by `loki.ts` and
 * `prometheus.ts` so the same hardened parser backs both tools' lockdown checks.
 */

/**
 * Strip `#`-to-end-of-line comments (outside quoted/backtick strings). Some
 * query languages built on this selector syntax (e.g. LogQL) ignore commented
 * text when executing a query, so a decoy selector hidden in a comment must
 * not be mistaken for the real one.
 */
function stripHashComments(query: string): string {
  let out = '';
  let i = 0;
  const n = query.length;
  while (i < n) {
    const ch = query[i];
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n && query[i] !== '"') {
        if (query[i] === '\\' && i + 1 < n) {
          out += query[i] + query[i + 1];
          i += 2;
        } else {
          out += query[i];
          i++;
        }
      }
      if (i < n) {
        out += query[i];
        i++;
      }
      continue;
    }
    if (ch === '`') {
      out += ch;
      i++;
      while (i < n && query[i] !== '`') {
        out += query[i];
        i++;
      }
      if (i < n) {
        out += query[i];
        i++;
      }
      continue;
    }
    if (ch === '#') {
      while (i < n && query[i] !== '\n') i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Find the index of the `}` that closes the brace opened at `start` in
 * `query[start]`. String literals (double-quoted, with backslash escapes, or
 * backtick-delimited raw strings) are skipped as opaque spans so that a brace
 * or quote inside a label value can't be mistaken for the real boundary.
 * Returns -1 if unterminated.
 */
function findMatchingBrace(query: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < query.length) {
    const ch = query[i];
    if (ch === '"') {
      i++;
      while (i < query.length && query[i] !== '"') {
        i += query[i] === '\\' ? 2 : 1;
      }
      i++;
      continue;
    }
    if (ch === '`') {
      i++;
      while (i < query.length && query[i] !== '`') i++;
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Extract every selector — each top-level `{...}` brace group — from a
 * query. Queries can combine more than one selector via binary/aggregation
 * operators (e.g. `sum(rate({a}[5m])) / sum(rate({b}[5m]))`), so a namespace
 * lockdown must check all of them, not just the first. Returns null if any
 * selector is unterminated.
 */
function extractAllSelectors(query: string): string[] | null {
  const selectors: string[] = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i];
    if (ch === '"') {
      i++;
      while (i < query.length && query[i] !== '"') {
        i += query[i] === '\\' ? 2 : 1;
      }
      i++;
      continue;
    }
    if (ch === '`') {
      i++;
      while (i < query.length && query[i] !== '`') i++;
      i++;
      continue;
    }
    if (ch === '{') {
      const end = findMatchingBrace(query, i);
      if (end === -1) return null;
      selectors.push(query.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    i++;
  }
  return selectors;
}

interface LabelMatcher {
  label: string;
  op: string;
  value: string;
}

const MATCHER_OPS = ['=~', '!~', '!=', '='];

/**
 * Parse a `{...}` selector into its label matchers. Returns null on anything
 * that doesn't parse as a well-formed matcher list — callers should fail
 * closed (reject) rather than guess at a malformed selector.
 */
function parseSelectorMatchers(selector: string): LabelMatcher[] | null {
  const inner = selector.slice(1, -1);
  const matchers: LabelMatcher[] = [];
  let i = 0;
  const n = inner.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(inner[i])) i++;
    if (i >= n) break;

    const labelStart = i;
    while (i < n && /[A-Za-z0-9_]/.test(inner[i])) i++;
    const label = inner.slice(labelStart, i);
    if (!label) return null;

    while (i < n && /\s/.test(inner[i])) i++;
    const op = MATCHER_OPS.find((candidate) => inner.startsWith(candidate, i));
    if (!op) return null;
    i += op.length;
    while (i < n && /\s/.test(inner[i])) i++;

    const quote = inner[i];
    if (quote !== '"' && quote !== '`') return null;
    i++;
    let value = '';
    if (quote === '"') {
      while (i < n && inner[i] !== '"') {
        if (inner[i] === '\\' && i + 1 < n) {
          // Only `\"` and `\\` decode to themselves under this naive scan.
          // Any other escape needs real string-literal decoding to get the
          // right value — since we don't implement that, fail closed rather
          // than silently mis-decoding in either direction.
          if (inner[i + 1] !== '"' && inner[i + 1] !== '\\') return null;
          value += inner[i + 1];
          i += 2;
        } else {
          value += inner[i];
          i++;
        }
      }
    } else {
      while (i < n && inner[i] !== '`') {
        value += inner[i];
        i++;
      }
    }
    if (i >= n) return null; // unterminated value
    i++; // consume closing quote/backtick

    matchers.push({ label, op, value });
  }
  return matchers;
}

/**
 * Check that every selector in a query contains an exact namespace matcher
 * for the locked namespace. Accepts `namespace="<ns>"` or `namespace=~"<ns>"`
 * (treated as an exact-string match, not a real regex evaluation), rejecting
 * anything else — a different value, a wildcard regex, negated operators
 * (!=, !~), or no namespace matcher at all.
 *
 * Queries can combine multiple selectors via binary/aggregation operators
 * (e.g. `sum(rate({a}[5m])) / sum(rate({b}[5m]))`), so every selector found
 * must pass — checking only the first would let a later selector read an
 * unlocked namespace while the whole query is forwarded unchanged. A query
 * with no selector at all is rejected (fail closed).
 *
 * Each selector is fully parsed into label/operator/value matchers rather
 * than regex-matched as raw text: a naive substring/regex check over the
 * selector text can be spoofed by decoy text inside another matcher's
 * backtick-quoted (unescaped) value. Parsing each matcher's value
 * independently closes that off. `#`-comments are stripped first so a decoy
 * selector hidden in a comment can't be validated in place of the real one.
 */
export function validateNamespaceSelectorLockdown(query: string, lockedNamespace: string): boolean {
  const selectors = extractAllSelectors(stripHashComments(query));
  if (selectors === null || selectors.length === 0) return false;
  return selectors.every((selector) => {
    const matchers = parseSelectorMatchers(selector);
    if (matchers === null) return false;
    return matchers.some(
      (m) => m.label === 'namespace' && (m.op === '=' || m.op === '=~') && m.value === lockedNamespace,
    );
  });
}
