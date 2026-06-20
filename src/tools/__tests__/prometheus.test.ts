import { describe, it, expect, vi, afterEach } from 'vitest';

const { runPrometheusQuery } = vi.hoisted(() => ({ runPrometheusQuery: vi.fn() }));
vi.mock('../../lib/prometheus.ts', () => ({ runPrometheusQuery }));

import { makePrometheusQuery } from '../prometheus.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  runPrometheusQuery.mockReset();
});

describe('makePrometheusQuery — URL precedence', () => {
  it('uses prometheusConfig.url when provided', async () => {
    runPrometheusQuery.mockResolvedValue('vector result');
    const tool = makePrometheusQuery({ url: 'http://custom-prom:9090' });
    await tool.execute({ queryType: 'instant', query: 'up' });
    expect(runPrometheusQuery).toHaveBeenCalledWith(
      'instant',
      expect.anything(),
      expect.objectContaining({ url: 'http://custom-prom:9090' }),
    );
  });

  it('falls back to PROMETHEUS_URL env when config url is absent', async () => {
    runPrometheusQuery.mockResolvedValue('vector result');
    vi.stubEnv('PROMETHEUS_URL', 'http://env-prom:9090');
    const tool = makePrometheusQuery({});
    await tool.execute({ queryType: 'instant', query: 'up' });
    expect(runPrometheusQuery).toHaveBeenCalledWith(
      'instant',
      expect.anything(),
      expect.objectContaining({ url: 'http://env-prom:9090' }),
    );
  });

  it('defaults to in-cluster URL when neither config nor env is set', async () => {
    runPrometheusQuery.mockResolvedValue('vector result');
    vi.stubEnv('PROMETHEUS_URL', '');
    const tool = makePrometheusQuery(null);
    await tool.execute({ queryType: 'instant', query: 'up' });
    expect(runPrometheusQuery).toHaveBeenCalledWith(
      'instant',
      expect.anything(),
      expect.objectContaining({ url: 'http://prometheus-operated.monitoring:9090' }),
    );
  });
});

describe('makePrometheusQuery — timeout precedence', () => {
  it('uses config timeoutMs when provided', async () => {
    runPrometheusQuery.mockResolvedValue('ok');
    const tool = makePrometheusQuery({ timeoutMs: 5000 });
    await tool.execute({ queryType: 'instant', query: 'up' });
    expect(runPrometheusQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timeoutMs: 5000 }),
    );
  });

  it('defaults to 10000ms when timeoutMs is absent', async () => {
    runPrometheusQuery.mockResolvedValue('ok');
    const tool = makePrometheusQuery({});
    await tool.execute({ queryType: 'instant', query: 'up' });
    expect(runPrometheusQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
  });
});

describe('makePrometheusQuery — tool metadata and params forwarding', () => {
  it('has the expected model-facing name', () => {
    expect(makePrometheusQuery().name).toBe('prometheus_query');
  });

  it('passes queryType and query params to runPrometheusQuery', async () => {
    runPrometheusQuery.mockResolvedValue('range result');
    const tool = makePrometheusQuery({});
    const result = await tool.execute({
      queryType: 'range',
      query: 'rate(http_requests_total[5m])',
      start: '2024-01-01T00:00:00Z',
      end: '2024-01-01T01:00:00Z',
      step: '30s',
    });
    expect(result).toBe('range result');
    expect(runPrometheusQuery).toHaveBeenCalledWith(
      'range',
      expect.objectContaining({
        query: 'rate(http_requests_total[5m])',
        start: '2024-01-01T00:00:00Z',
        end: '2024-01-01T01:00:00Z',
        step: '30s',
      }),
      expect.anything(),
    );
  });
});
