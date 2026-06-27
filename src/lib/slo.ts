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

/**
 * Result of parsing a Prometheus instant query response.
 * Either a successfully extracted numeric value or a descriptive error string.
 */
export type ParsedInstantValue = { value: number } | { error: string };

/**
 * Extract a single scalar value from a raw Prometheus instant query JSON response.
 *
 * Returns `{ value }` on success or `{ error }` for any failure mode:
 * - JSON parse error
 * - Non-success status or empty result array
 * - Missing or NaN value field
 *
 * This is a pure function — no I/O, fully unit-testable in isolation.
 */
export function parseInstantQueryValue(raw: string): ParsedInstantValue {
  type InstantResponse = {
    status?: string;
    data?: { result?: Array<{ value?: [number, string] }> };
  };

  let parsed: InstantResponse;
  try {
    parsed = JSON.parse(raw) as InstantResponse;
  } catch {
    return { error: `Failed to parse Prometheus response: ${raw.slice(0, 120)}` };
  }

  if (parsed && typeof parsed === 'object' && parsed.status === 'success' && parsed.data?.result?.length) {
    const rawValue = parsed.data.result[0]?.value?.[1];
    if (rawValue !== undefined) {
      const value = parseFloat(rawValue);
      if (!isNaN(value)) return { value };
    }
  }

  return { error: 'No metric data returned for this SLO.' };
}

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

/**
 * Evaluate a single SLO against live Prometheus data.
 *
 * Queries the `slo.metric` PromQL expression as an instant query, extracts the
 * first vector result value, and computes:
 *   burnRate       = currentValue / slo.budget
 *   remainingBudget = max(0, 1 − burnRate)
 *   breaching      = burnRate > 1
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
  // runPrometheusQuery never throws — it returns error strings for all failure modes.
  const raw = await runPrometheusQuery('instant', { query: slo.metric }, prometheusConfig);
  const parsed = parseInstantQueryValue(raw);

  if ('error' in parsed) {
    return { name: slo.name, burnRate: 0, remainingBudget: 1, breaching: false, error: parsed.error };
  }

  const currentValue = parsed.value;
  // Burn rate: how many times faster than allowed we're consuming the error budget.
  // Clamp to 0 to guard against metrics that return negative values.
  const burnRate = slo.budget > 0 ? Math.max(0, currentValue) / slo.budget : 0;
  const remainingBudget = Math.max(0, 1 - burnRate);
  const breaching = burnRate > 1;

  return { name: slo.name, burnRate, remainingBudget, breaching, currentValue };
}
