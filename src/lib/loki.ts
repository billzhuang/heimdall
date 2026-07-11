/**
 * Pure HTTP helpers for Grafana Loki log query API access.
 *
 * Only uses the read-only /loki/api/v1/query_range endpoint — never pushes
 * or deletes logs. The Loki base URL and timeout come from trusted config/env,
 * never from model-selected arguments.
 */
import type { CompiledRedactionRule } from './regex-redact.ts';
import { makeTruncate } from './output-truncation.ts';
import { resolveTimePassthrough } from './time-resolution.ts';
import { runJsonQuery } from './http.ts';
import { clampLimit } from './tool-config.ts';
import { BLOCKED_PREFIX } from './harness.ts';

export interface LokiConfig {
  url: string;
  timeoutMs: number;
  /** User-configured regex redaction rules compiled at startup. */
  regexRedactionRules?: CompiledRedactionRule[];
  /** When set, all queries are rejected unless the LogQL selector includes namespace="<value>". */
  lockedNamespace?: string;
}

const MAX_RESULT_CHARS = 20_000;
const MAX_LIMIT = 5_000;
const truncate = makeTruncate(MAX_RESULT_CHARS, 'use a narrower time range, smaller limit, or more specific LogQL selector');

/**
 * Resolve a time expression to an ISO8601 string for the Loki API.
 * See `resolveTimePassthrough` in time-resolution.ts for full semantics.
 */
export const resolveTime = resolveTimePassthrough;

/**
 * Strip LogQL `#`-to-end-of-line comments (outside quoted/backtick strings).
 * Loki ignores commented text when executing a query, so a decoy stream
 * selector hidden in a comment must not be mistaken for the real one.
 */
function stripLogQLComments(query: string): string {
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
 * `query[start]`. LogQL string literals (double-quoted, with backslash
 * escapes, or backtick-delimited raw strings) are skipped as opaque spans so
 * that a brace or quote inside a label value can't be mistaken for the real
 * boundary. Returns -1 if unterminated.
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
 * Extract every LogQL stream selector — each top-level `{...}` brace group —
 * from a query. LogQL metric queries can combine more than one selector via
 * binary operators (e.g. `sum(rate({a}[5m])) / sum(rate({b}[5m]))`), so a
 * namespace lockdown must check all of them, not just the first. Returns null
 * if any selector is unterminated.
 */
function extractAllStreamSelectors(query: string): string[] | null {
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
 * Parse a `{...}` LogQL stream selector into its label matchers. Returns null
 * on anything that doesn't parse as a well-formed matcher list — callers
 * should fail closed (reject) rather than guess at a malformed selector.
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
 * Check that every LogQL stream selector in a query contains an exact
 * namespace matcher for the locked namespace. Accepts namespace="<ns>" or
 * namespace=~"<ns>" (treated as an exact-string match, not a real regex
 * evaluation), rejecting anything else — a different value, a wildcard
 * regex, negated operators (!=, !~), or no namespace matcher at all.
 *
 * Metric queries can combine multiple selectors via binary operators (e.g.
 * `sum(rate({a}[5m])) / sum(rate({b}[5m]))`), so every selector found must
 * pass — checking only the first would let a later selector read an
 * unlocked namespace while the whole query is forwarded to Loki unchanged.
 * A query with no selector at all is rejected (fail closed).
 *
 * Each selector is fully parsed into label/operator/value matchers rather
 * than regex-matched as raw text: a naive substring/regex check over the
 * selector text can be spoofed by decoy text inside another matcher's
 * backtick-quoted (unescaped) value — e.g. `app=~\`namespace="prod"\`` — while
 * the real namespace matcher targets something else entirely. Parsing each
 * matcher's value independently closes that off. `#`-comments are stripped
 * first so a decoy selector hidden in a comment (which Loki itself ignores)
 * can't be validated in place of the real, executed selector.
 */
export function validateNamespaceLockdown(query: string, lockedNamespace: string): boolean {
  const selectors = extractAllStreamSelectors(stripLogQLComments(query));
  if (selectors === null || selectors.length === 0) return false;
  return selectors.every((selector) => {
    const matchers = parseSelectorMatchers(selector);
    if (matchers === null) return false;
    return matchers.some(
      (m) => m.label === 'namespace' && (m.op === '=' || m.op === '=~') && m.value === lockedNamespace,
    );
  });
}

export interface LokiQueryParams {
  query: string;
  start?: string | null;
  end?: string | null;
  limit?: number | null;
  direction?: 'forward' | 'backward';
}

const DEFAULT_LIMIT = 100;
const DEFAULT_DIRECTION = 'backward';

/**
 * Execute a read-only Loki log range query and return the raw JSON response as a string.
 *
 * Validates required params, enforces namespace lockdown when configured,
 * clamps the limit to MAX_LIMIT, applies a request timeout, truncates output,
 * and applies regex redaction rules before returning to the model.
 */
export async function runLokiQuery(params: LokiQueryParams, config: LokiConfig): Promise<string> {
  if (!params.query.trim()) {
    return 'Error: query must be a non-empty LogQL expression (e.g. \'{namespace="prod"} |= "ERROR"\').';
  }

  // Namespace lockdown: code-enforced when config.lockedNamespace is set.
  // The LogQL query must contain an exact namespace="<locked>" selector —
  // any selector that could match other namespaces is rejected.
  if (config.lockedNamespace) {
    if (!validateNamespaceLockdown(params.query, config.lockedNamespace)) {
      return (
        `${BLOCKED_PREFIX}namespace lockdown is active — queries must include ` +
        `namespace="${config.lockedNamespace}" in the stream selector. ` +
        `Example: '{namespace="${config.lockedNamespace}", app="my-app"} |= "ERROR"'`
      );
    }
  }

  const nowMs = Date.now();
  const startResolved = resolveTime(params.start ?? '-1h', nowMs);
  const endResolved = resolveTime(params.end ?? new Date(nowMs).toISOString(), nowMs);

  const effectiveLimit = clampLimit(params.limit, DEFAULT_LIMIT, MAX_LIMIT);

  return runJsonQuery(config, '/loki/api/v1/query_range', 'Loki', truncate, (searchParams) => {
    searchParams.set('query', params.query);
    searchParams.set('start', startResolved);
    searchParams.set('end', endResolved);
    searchParams.set('limit', String(effectiveLimit));
    searchParams.set('direction', params.direction ?? DEFAULT_DIRECTION);
  });
}
