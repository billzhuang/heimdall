import { describe, it, expect, vi, afterEach } from 'vitest';
import { evaluateSLO, parsePrometheusScalar, computeSloMetrics } from '../slo.ts';
import type { SloDefinition, ParsedScalar } from '../slo.ts';
import type { PrometheusConfig } from '../prometheus.ts';
import { mockFetch } from './test-helpers.ts';

const BASE_CONFIG: PrometheusConfig = { url: 'http://prometheus:9090', timeoutMs: 5_000 };

const API_SLO: SloDefinition = {
  name: 'API availability',
  metric: 'sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))',
  target: 0.999,
  window: '30d',
  budget: 0.001,
};

/** Return a Prometheus instant query response with a single vector result. */
function prometheusVectorResponse(value: number): string {
  return JSON.stringify({
    status: 'success',
    data: {
      resultType: 'vector',
      result: [{ metric: {}, value: [1700000000, String(value)] }],
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Burn rate calculation
// ---------------------------------------------------------------------------

describe('evaluateSLO — burn rate calculation', () => {
  it('returns burnRate = 1.0 when error rate equals budget exactly', async () => {
    mockFetch(prometheusVectorResponse(0.001));
    const result = await evaluateSLO(BASE_CONFIG, API_SLO);
    expect(result.burnRate).toBeCloseTo(1.0, 5);
    expect(result.breaching).toBe(false);
    expect(result.remainingBudget).toBeCloseTo(0, 5);
    expect(result.currentValue).toBeCloseTo(0.001, 5);
  });

  it('returns burnRate > 1 and breaching = true when error rate exceeds budget', async () => {
    // 5x the budget → burn rate 5.0
    mockFetch(prometheusVectorResponse(0.005));
    const result = await evaluateSLO(BASE_CONFIG, API_SLO);
    expect(result.burnRate).toBeCloseTo(5.0, 5);
    expect(result.breaching).toBe(true);
    expect(result.remainingBudget).toBe(0);
    expect(result.currentValue).toBeCloseTo(0.005, 5);
  });

  it('returns burnRate < 1 and breaching = false when error rate is within budget', async () => {
    // Half the budget → burn rate 0.5, 50% budget remaining
    mockFetch(prometheusVectorResponse(0.0005));
    const result = await evaluateSLO(BASE_CONFIG, API_SLO);
    expect(result.burnRate).toBeCloseTo(0.5, 5);
    expect(result.breaching).toBe(false);
    expect(result.remainingBudget).toBeCloseTo(0.5, 5);
  });

  it('returns burnRate = 0 and remainingBudget = 1 when error rate is zero', async () => {
    mockFetch(prometheusVectorResponse(0));
    const result = await evaluateSLO(BASE_CONFIG, API_SLO);
    expect(result.burnRate).toBe(0);
    expect(result.breaching).toBe(false);
    expect(result.remainingBudget).toBe(1);
  });

  it('clamps remainingBudget to 0 when burnRate > 1', async () => {
    // 10x budget
    mockFetch(prometheusVectorResponse(0.01));
    const result = await evaluateSLO(BASE_CONFIG, API_SLO);
    expect(result.remainingBudget).toBe(0);
  });

  it('clamps negative metric values to burnRate 0 and remainingBudget 1', async () => {
    // A metric that returns a negative value (e.g. a misconfigured counter) should
    // not produce a negative burn rate or a remainingBudget > 1.
    mockFetch(prometheusVectorResponse(-0.001));
    const result = await evaluateSLO(BASE_CONFIG, API_SLO);
    expect(result.burnRate).toBe(0);
    expect(result.remainingBudget).toBe(1);
    expect(result.breaching).toBe(false);
    // currentValue reflects the raw metric value as returned by Prometheus.
    expect(result.currentValue).toBeCloseTo(-0.001, 5);
  });
});

// ---------------------------------------------------------------------------
// SLO name passthrough
// ---------------------------------------------------------------------------

describe('evaluateSLO — name passthrough', () => {
  it('includes the SLO name in the result', async () => {
    mockFetch(prometheusVectorResponse(0.0005));
    const result = await evaluateSLO(BASE_CONFIG, API_SLO);
    expect(result.name).toBe('API availability');
  });
});

// ---------------------------------------------------------------------------
// Error handling — no data
// ---------------------------------------------------------------------------

describe('evaluateSLO — no data / empty result', () => {
  it('returns error when Prometheus returns an empty result array', async () => {
    mockFetch(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [] } }));
    const result = await evaluateSLO(BASE_CONFIG, API_SLO);
    expect(result.error).toBeDefined();
    expect(result.breaching).toBe(false);
    expect(result.burnRate).toBe(0);
    expect(result.remainingBudget).toBe(1);
  });

  it('returns error when Prometheus response is not valid JSON', async () => {
    mockFetch('not-json');
    const result = await evaluateSLO(BASE_CONFIG, API_SLO);
    expect(result.error).toMatch(/Failed to parse/i);
    expect(result.breaching).toBe(false);
  });

  it('returns error when Prometheus returns an HTTP error', async () => {
    mockFetch('bad expression', 400);
    const result = await evaluateSLO(BASE_CONFIG, API_SLO);
    // The raw error string from runPrometheusQuery isn't valid JSON, so we get a parse error
    expect(result.error).toBeDefined();
    expect(result.breaching).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Zero-budget guard
// ---------------------------------------------------------------------------

describe('evaluateSLO — zero budget guard', () => {
  it('returns burnRate 0 when budget is 0 to avoid division by zero', async () => {
    mockFetch(prometheusVectorResponse(0.01));
    const zeroBudgetSlo: SloDefinition = { ...API_SLO, budget: 0 };
    const result = await evaluateSLO(BASE_CONFIG, zeroBudgetSlo);
    expect(result.burnRate).toBe(0);
    expect(result.breaching).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Different SLO targets and windows
// ---------------------------------------------------------------------------

describe('evaluateSLO — various SLO configurations', () => {
  it('correctly evaluates a p99 latency SLO with a tight budget', async () => {
    const latencySlo: SloDefinition = {
      name: 'p99 latency',
      metric: 'histogram_quantile(0.99, rate(http_duration_seconds_bucket[5m]))',
      target: 0.995,
      window: '7d',
      budget: 0.005,
    };
    // 0.002 / 0.005 = 0.4 burn rate → healthy
    mockFetch(prometheusVectorResponse(0.002));
    const result = await evaluateSLO(BASE_CONFIG, latencySlo);
    expect(result.name).toBe('p99 latency');
    expect(result.burnRate).toBeCloseTo(0.4, 5);
    expect(result.breaching).toBe(false);
    expect(result.remainingBudget).toBeCloseTo(0.6, 5);
  });
});

// ---------------------------------------------------------------------------
// parsePrometheusScalar — pure parsing, no I/O
// ---------------------------------------------------------------------------

describe('parsePrometheusScalar', () => {
  it('extracts the scalar value from a well-formed vector response', () => {
    const raw = JSON.stringify({
      status: 'success',
      data: { result: [{ metric: {}, value: [1700000000, '0.0023'] }] },
    });
    const result = parsePrometheusScalar(raw);
    expect(result.ok).toBe(true);
    expect((result as Extract<ParsedScalar, { ok: true }>).value).toBeCloseTo(0.0023, 6);
  });

  it('returns ok:false for invalid JSON', () => {
    const result = parsePrometheusScalar('not-json');
    expect(result.ok).toBe(false);
    expect((result as Extract<ParsedScalar, { ok: false }>).error).toMatch(/Failed to parse/i);
  });

  it('returns ok:false when result array is empty', () => {
    const raw = JSON.stringify({ status: 'success', data: { result: [] } });
    expect(parsePrometheusScalar(raw).ok).toBe(false);
  });

  it('returns ok:false when status is not "success"', () => {
    const raw = JSON.stringify({ status: 'error', data: { result: [] } });
    expect(parsePrometheusScalar(raw).ok).toBe(false);
  });

  it('returns ok:false when the value string is NaN', () => {
    const raw = JSON.stringify({
      status: 'success',
      data: { result: [{ metric: {}, value: [1700000000, 'NaN'] }] },
    });
    expect(parsePrometheusScalar(raw).ok).toBe(false);
  });

  it('handles integer-valued metrics (e.g. "0")', () => {
    const raw = JSON.stringify({
      status: 'success',
      data: { result: [{ metric: {}, value: [1700000000, '0'] }] },
    });
    const result = parsePrometheusScalar(raw);
    expect(result.ok).toBe(true);
    expect((result as Extract<ParsedScalar, { ok: true }>).value).toBe(0);
  });

  it('returns ok:false when data is missing entirely', () => {
    const raw = JSON.stringify({ status: 'success' });
    expect(parsePrometheusScalar(raw).ok).toBe(false);
  });

  it('truncates the raw string in the error message to ≤120 chars', () => {
    const raw = 'x'.repeat(200);
    const result = parsePrometheusScalar(raw);
    expect(result.ok).toBe(false);
    const err = (result as Extract<ParsedScalar, { ok: false }>).error;
    expect(err.length).toBeLessThanOrEqual('Failed to parse Prometheus response: '.length + 120);
  });
});

// ---------------------------------------------------------------------------
// computeSloMetrics — pure math, no I/O
// ---------------------------------------------------------------------------

describe('computeSloMetrics', () => {
  it('returns burnRate 1.0, remainingBudget 0, breaching false when value equals budget', () => {
    const result = computeSloMetrics(0.001, 0.001);
    expect(result.burnRate).toBeCloseTo(1.0, 10);
    expect(result.remainingBudget).toBeCloseTo(0, 10);
    expect(result.breaching).toBe(false);
  });

  it('returns breaching true when value exceeds budget', () => {
    const result = computeSloMetrics(0.005, 0.001);
    expect(result.burnRate).toBeCloseTo(5.0, 5);
    expect(result.breaching).toBe(true);
    expect(result.remainingBudget).toBe(0);
  });

  it('returns breaching false and remainingBudget > 0 when value is under budget', () => {
    const result = computeSloMetrics(0.0005, 0.001);
    expect(result.burnRate).toBeCloseTo(0.5, 5);
    expect(result.breaching).toBe(false);
    expect(result.remainingBudget).toBeCloseTo(0.5, 5);
  });

  it('clamps burnRate to 0 for a negative metric value', () => {
    const result = computeSloMetrics(-0.002, 0.001);
    expect(result.burnRate).toBe(0);
    expect(result.remainingBudget).toBe(1);
    expect(result.breaching).toBe(false);
  });

  it('returns burnRate 0 when budget is zero (no division by zero)', () => {
    const result = computeSloMetrics(0.01, 0);
    expect(result.burnRate).toBe(0);
    expect(result.breaching).toBe(false);
  });

  it('returns burnRate 0 and remainingBudget 1 for a zero error rate', () => {
    const result = computeSloMetrics(0, 0.001);
    expect(result.burnRate).toBe(0);
    expect(result.remainingBudget).toBe(1);
  });

  it('clamps remainingBudget to 0 when burn rate is very high', () => {
    const result = computeSloMetrics(1.0, 0.001); // 1000x budget
    expect(result.remainingBudget).toBe(0);
    expect(result.breaching).toBe(true);
  });
});
