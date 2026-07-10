/**
 * SLO definition shape shared by config loading (`config.ts`) and prompt
 * building (`triage.ts`, `instructions.ts`). Live SLO evaluation is delegated
 * to the `slo-evaluator` subagent, which computes burn rate itself via the
 * `prometheus_query` tool rather than through a compiled evaluation path.
 */

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
