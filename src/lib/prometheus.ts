/**
 * Pure HTTP helpers for Prometheus query API access.
 *
 * Supports instant queries (/api/v1/query) and range queries (/api/v1/query_range).
 * The Prometheus base URL and timeout come from trusted config/env — never from
 * model-selected arguments.
 */
import type { CompiledRedactionRule } from './regex-redact.ts';
import { makeTruncate } from './output-truncation.ts';
import { runJsonQuery } from './http.ts';
import { BLOCKED_PREFIX } from './harness.ts';
import { findMatchingDelimiter, validateNamespaceSelectorLockdown } from './selector-lockdown.ts';

export interface PrometheusConfig {
  url: string;
  timeoutMs: number;
  /** User-configured regex redaction rules compiled at startup. */
  regexRedactionRules?: CompiledRedactionRule[];
  /** When set, all queries are rejected unless every vector selector includes namespace="<value>". */
  lockedNamespace?: string;
}

/**
 * PromQL aggregation operators, functions, and keywords that are never
 * themselves a metric-name reference — an identifier matching one of these
 * never fetches unscoped data on its own, regardless of what follows it.
 * https://prometheus.io/docs/prometheus/latest/querying/operators/
 * https://prometheus.io/docs/prometheus/latest/querying/functions/
 */
const PROMQL_SAFE_IDENTIFIERS = new Set([
  // Aggregation operators
  'sum', 'min', 'max', 'avg', 'group', 'stddev', 'stdvar', 'count',
  'count_values', 'bottomk', 'topk', 'quantile', 'limitk', 'limit_ratio',
  // Vector-matching / aggregation modifiers and binary-operator keywords
  'by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'bool', 'offset',
  'and', 'or', 'unless', 'atan2',
  // Functions
  'abs', 'absent', 'absent_over_time', 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atanh',
  'avg_over_time', 'ceil', 'changes', 'clamp', 'clamp_max', 'clamp_min', 'cos', 'cosh',
  'count_over_time', 'days_in_month', 'day_of_month', 'day_of_week', 'day_of_year',
  'delta', 'deriv', 'end', 'exp', 'floor', 'histogram_avg', 'histogram_count',
  'histogram_fraction', 'histogram_quantile', 'histogram_stddev', 'histogram_stdvar',
  'histogram_sum', 'holt_winters', 'hour', 'idelta', 'increase', 'info', 'irate',
  'label_join', 'label_replace', 'last_over_time', 'ln', 'log2', 'log10', 'mad_over_time',
  'max_over_time', 'min_over_time', 'minute', 'month', 'predict_linear', 'present_over_time',
  'quantile_over_time', 'rate', 'resets', 'round', 'scalar', 'sgn', 'sin', 'sinh', 'sort',
  'sort_desc', 'sort_by_label', 'sort_by_label_desc', 'sqrt', 'start', 'stddev_over_time',
  'stdvar_over_time', 'sum_over_time', 'tan', 'tanh', 'time', 'timestamp', 'vector', 'year',
]);

/** Modifiers whose parenthesized argument is a label list, never a metric reference. */
const LABEL_LIST_KEYWORDS = new Set(['by', 'without', 'on', 'ignoring', 'group_left', 'group_right']);

/**
 * Detect a bare PromQL metric-name reference: an identifier that is not a
 * recognized aggregation/function/keyword and is not immediately (optionally
 * across whitespace) followed by a `{...}` selector.
 *
 * `validateNamespaceSelectorLockdown` only inspects the `{...}` selectors it
 * can find — it has no notion of PromQL grammar. A query can smuggle
 * unscoped data past it by combining one namespace-scoped selector with a
 * second, bare metric reference via a binary operator or set operator (e.g.
 * `up{namespace="prod"} + up`, `container_memory_usage_bytes or
 * kube_pod_info{namespace="prod"}`): the bare term has no selector to check,
 * so it's invisible to that validator even though Prometheus executes it
 * unscoped. This scan closes that gap by requiring every metric reference in
 * the query to carry a selector, fail-closed on anything it can't place
 * (unterminated brackets, an identifier it can't classify).
 *
 * Numbers and durations (`5m`, `1h30m`, `3.14`) can never start a PromQL
 * identifier, so any digit-led alphanumeric run is skipped as one opaque
 * token rather than misread as a trailing unit-suffix identifier (e.g. the
 * `m` in `5m`). `[...]` range-vector/subquery brackets are skipped entirely
 * for the same reason `{...}` selectors are — their contents are never a
 * bare metric reference.
 */
function hasBareMetricReference(query: string): boolean {
  let i = 0;
  const n = query.length;
  while (i < n) {
    const ch = query[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < n && query[i] !== quote) {
        i += query[i] === '\\' ? 2 : 1;
      }
      i++;
      continue;
    }
    if (ch === '`') {
      i++;
      while (i < n && query[i] !== '`') i++;
      i++;
      continue;
    }
    if (ch === '{') {
      const end = findMatchingDelimiter(query, i, '{', '}');
      if (end === -1) return true; // unterminated selector — fail closed
      i = end + 1;
      continue;
    }
    if (ch === '[') {
      const end = findMatchingDelimiter(query, i, '[', ']');
      if (end === -1) return true;
      i = end + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      while (i < n && /[0-9a-zA-Z.]/.test(query[i])) i++;
      continue;
    }
    if (/[A-Za-z_:]/.test(ch)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_:]/.test(query[i])) i++;
      const identifier = query.slice(start, i);

      let j = i;
      while (j < n && /\s/.test(query[j])) j++;

      if (LABEL_LIST_KEYWORDS.has(identifier) && query[j] === '(') {
        const end = findMatchingDelimiter(query, j, '(', ')');
        if (end === -1) return true;
        i = end + 1;
        continue;
      }
      if (PROMQL_SAFE_IDENTIFIERS.has(identifier)) continue;
      if (query[j] === '{') continue; // has its own selector, validated separately

      return true; // bare metric-name reference with no selector
    }
    i++;
  }
  return false;
}

/**
 * Check that every metric reference in a PromQL query carries a selector
 * with an exact namespace matcher for the locked namespace. Combines
 * {@link validateNamespaceSelectorLockdown} (every `{...}` selector found
 * must match) with {@link hasBareMetricReference} (no metric reference may
 * lack a selector entirely) — the first alone is insufficient for PromQL
 * because, unlike LogQL, a bare metric name with no braces is itself a valid,
 * unscoped vector selector.
 */
export function validateNamespaceLockdown(query: string, lockedNamespace: string): boolean {
  return validateNamespaceSelectorLockdown(query, lockedNamespace) && !hasBareMetricReference(query);
}

const MAX_RESULT_CHARS = 20_000;
const truncate = makeTruncate(MAX_RESULT_CHARS, 'use a shorter time range, coarser step, or more specific selector');

export interface PrometheusQueryParams {
  query: string;
  time?: string;
  start?: string;
  end?: string;
  step?: string;
}

/**
 * Execute a read-only Prometheus query and return the raw JSON response as a string.
 *
 * Validates required params for range queries before making the network call,
 * applies a request timeout, and caps output to avoid blowing the model's context.
 */
export async function runPrometheusQuery(
  queryType: 'instant' | 'range',
  params: PrometheusQueryParams,
  config: PrometheusConfig,
): Promise<string> {
  if (queryType === 'range') {
    if (!params.start) return 'Error: range queries require a start parameter (RFC3339 or Unix seconds).';
    if (!params.end) return 'Error: range queries require an end parameter (RFC3339 or Unix seconds).';
    if (!params.step) return 'Error: range queries require a step parameter (e.g. "15s", "1m").';
  }

  // Namespace lockdown: code-enforced when config.lockedNamespace is set.
  // The PromQL query must contain an exact namespace="<locked>" selector on
  // every vector selector — any selector that could match other namespaces
  // (or the absence of a selector) is rejected.
  if (config.lockedNamespace && !validateNamespaceLockdown(params.query, config.lockedNamespace)) {
    return (
      `${BLOCKED_PREFIX}namespace lockdown is active — queries must include ` +
      `namespace="${config.lockedNamespace}" in every vector selector. ` +
      `Example: 'up{namespace="${config.lockedNamespace}"}'`
    );
  }

  const endpoint = queryType === 'instant' ? '/api/v1/query' : '/api/v1/query_range';

  return runJsonQuery(config, endpoint, 'Prometheus', truncate, (searchParams) => {
    searchParams.set('query', params.query);
    if (queryType === 'instant') {
      if (params.time) searchParams.set('time', params.time);
    } else {
      searchParams.set('start', params.start!);
      searchParams.set('end', params.end!);
      searchParams.set('step', params.step!);
    }
  });
}
