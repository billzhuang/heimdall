/**
 * SLO evaluation: load SLO definitions and compute error budget burn rate.
 *
 * Queries Prometheus for the current metric value, then computes the burn rate
 * and remaining budget for each SLO definition.
 *
 * The `metric` field is expected to be a PromQL expression that returns a
 * single scalar representing the current error rate / non-compliance fraction
 * (a value between 0 and 1).  For example:
 *   `sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))`
 *
 * Burn rate > 1 means the error budget is being consumed faster than the
 * allowed rate and the SLO is considered breaching.
 */
import { runPrometheusQuery } from './prometheus.ts';
import type { PrometheusConfig } from './prometheus.ts';

/** A single SLO definition from the config. */
export interface SloDefinition {
  /** Human-readable name, e.g. "API availability" or "p99 latency". */
  name: string;
  /**
   * PromQL expression returning the current error rate / non-compliance
   * fraction (0–1).  Example:
   * `sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))`
   */
  metric: string;
  /** SLO target as a fraction, e.g. 0.999 for 99.9% availability. */
  target: number;
  /** Measurement window, e.g. "30d", "7d".  Informational — shown in reports. */
  window: string;
  /** Error budget as a fraction, e.g. 0.001 for 0.1%.  Typically equals (1 − target). */
  budget: number;
}

/** Result of evaluating a single SLO against live observability data. */
export interface SloResult {
  /** Name of the SLO. */
  name: string;
  /**
   * How many times faster than allowed the error budget is being consumed.
   * 1.0 = consuming exactly at budget; > 1.0 = over budget (breaching).
   */
  burnRate: number;
  /**
   * Fraction of error budget remaining (0–1).
   * Computed as max(0, 1 − burnRate).  When breaching, this is 0.
   */
  remainingBudget: number;
  /** True when the current error rate exceeds the error budget (burnRate > 1). */
  breaching: boolean;
  /** Raw metric value returned by Prometheus, if available. */
  currentValue?: number;
  /** Error message when the metric query failed or returned no data. */
  error?: string;
}

type PrometheusInstantResponse = {
  status?: string;
  data?: { result?: Array<{ value?: [number, string] }> };
};

/** Discriminated result type for `parsePrometheusScalar`. */
export type ParsedScalar =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * Parse a raw Prometheus instant-query JSON response and extract the first
 * scalar value from the result vector.
 *
 * Returns `{ ok: true, value }` on success, or `{ ok: false, error }` when
 * the response is malformed, empty, or the parsed value is NaN.  This is a
 * pure function with no I/O, making it independently testable without mocking
 * fetch.
 */
export function parsePrometheusScalar(raw: string): ParsedScalar {
  let parsed: PrometheusInstantResponse;
  try {
    parsed = JSON.parse(raw) as PrometheusInstantResponse;
  } catch {
    return { ok: false, error: `Failed to parse Prometheus response: ${raw.slice(0, 120)}` };
  }

  if (parsed.status === 'success' && parsed.data?.result?.length) {
    const rawValue = parsed.data.result[0]?.value?.[1];
    if (rawValue !== undefined) {
      const value = parseFloat(rawValue);
      if (!isNaN(value)) return { ok: true, value };
    }
  }

  return { ok: false, error: 'No metric data returned for this SLO.' };
}

/**
 * Compute burn rate, remaining budget, and breach status from a raw metric
 * value and an error budget fraction.
 *
 * Pure function — no I/O, safe to unit-test directly.
 *
 * @param currentValue  Raw error rate / non-compliance fraction from Prometheus.
 * @param budget        SLO error budget as a fraction (e.g. 0.001 for 0.1%).
 */
export function computeSloMetrics(
  currentValue: number,
  budget: number,
): { burnRate: number; remainingBudget: number; breaching: boolean } {
  // Guard against zero budget to avoid division by zero; treat it as "no budget
  // allocated" — burn rate is meaningless, so we return 0.
  const burnRate = budget > 0 ? Math.max(0, currentValue) / budget : 0;
  const remainingBudget = Math.max(0, 1 - burnRate);
  const breaching = burnRate > 1;
  return { burnRate, remainingBudget, breaching };
}

/**
 * Evaluate a single SLO against live Prometheus data.
 *
 * Queries the `slo.metric` PromQL expression as an instant query and delegates
 * response parsing to `parsePrometheusScalar` and the burn-rate math to
 * `computeSloMetrics`.
 *
 * NOTE: burnRate and remainingBudget are derived from the *instantaneous* rate
 * returned by the PromQL expression (typically a short-window rate like
 * `rate(...[5m])`). They reflect how fast the budget is being consumed right
 * now vs. the allowed rate, not the cumulative fraction of the SLO window
 * budget already spent. Use a cumulative error-budget PromQL expression
 * (e.g. `sum_over_time` over `slo.window`) if you need true remaining-budget.
 */
export async function evaluateSLO(
  prometheusConfig: PrometheusConfig,
  slo: SloDefinition,
): Promise<SloResult> {
  const errResult = (error: string): SloResult => ({
    name: slo.name,
    burnRate: 0,
    remainingBudget: 1,
    breaching: false,
    error,
  });

  let raw: string;
  try {
    raw = await runPrometheusQuery('instant', { query: slo.metric }, prometheusConfig);
  } catch (err) {
    return errResult(
      `Failed to query Prometheus: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = parsePrometheusScalar(raw);
  if (!parsed.ok) return errResult(parsed.error);

  const { burnRate, remainingBudget, breaching } = computeSloMetrics(parsed.value, slo.budget);
  return { name: slo.name, burnRate, remainingBudget, breaching, currentValue: parsed.value };
}
