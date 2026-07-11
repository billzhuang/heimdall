import { describe, it, expect, vi, afterEach } from 'vitest';

const { runPrometheusQuery } = vi.hoisted(() => ({ runPrometheusQuery: vi.fn() }));
vi.mock('../../lib/prometheus.ts', () => ({ runPrometheusQuery }));

import { makePrometheusQuery, prometheusPlugin } from '../prometheus.ts';
import type { CompiledRedactionRule } from '../../lib/regex-redact.ts';
import type { HeimdallConfig } from '../../lib/config.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  runPrometheusQuery.mockReset();
});

describe('makePrometheusQuery — URL precedence', () => {
  it('uses prometheusConfig.url when provided', async () => {
    runPrometheusQuery.mockResolvedValue('vector result');
    const tool = makePrometheusQuery({ url: 'http://custom-prom:9090' });
    await tool.run({ input: { queryType: 'instant', query: 'up' } });
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
    await tool.run({ input: { queryType: 'instant', query: 'up' } });
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
    await tool.run({ input: { queryType: 'instant', query: 'up' } });
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
    await tool.run({ input: { queryType: 'instant', query: 'up' } });
    expect(runPrometheusQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timeoutMs: 5000 }),
    );
  });

  it('defaults to 10000ms when timeoutMs is absent', async () => {
    runPrometheusQuery.mockResolvedValue('ok');
    const tool = makePrometheusQuery({});
    await tool.run({ input: { queryType: 'instant', query: 'up' } });
    expect(runPrometheusQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
  });

  it.each([0, -1, Infinity, NaN])('falls back to default when timeoutMs is %s', async (bad) => {
    runPrometheusQuery.mockResolvedValue('ok');
    const tool = makePrometheusQuery({ timeoutMs: bad });
    await tool.run({ input: { queryType: 'instant', query: 'up' } });
    expect(runPrometheusQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
  });
});

describe('makePrometheusQuery — namespace lockdown', () => {
  it('bakes lockedNamespace into the config passed to runPrometheusQuery', async () => {
    runPrometheusQuery.mockResolvedValue('ok');
    const tool = makePrometheusQuery({}, undefined, 'prod-payments');
    await tool.run({ input: { queryType: 'instant', query: 'up{namespace="prod-payments"}' } });
    expect(runPrometheusQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ lockedNamespace: 'prod-payments' }),
    );
  });

  it('description mentions lockdown when active', () => {
    const tool = makePrometheusQuery({}, undefined, 'prod-payments');
    expect(tool.description).toContain('NAMESPACE LOCKDOWN ACTIVE');
    expect(tool.description).toContain('prod-payments');
  });

  it('description has no lockdown note when no lock is set', () => {
    const tool = makePrometheusQuery();
    expect(tool.description).not.toContain('NAMESPACE LOCKDOWN');
  });
});

describe('makePrometheusQuery — tool metadata and params forwarding', () => {
  it('has the expected model-facing name', () => {
    expect(makePrometheusQuery().name).toBe('prometheus_query');
  });

  it('passes queryType and query params to runPrometheusQuery', async () => {
    runPrometheusQuery.mockResolvedValue('range result');
    const tool = makePrometheusQuery({});
    const result = await tool.run({ input: {
      queryType: 'range',
      query: 'rate(http_requests_total[5m])',
      start: '2024-01-01T00:00:00Z',
      end: '2024-01-01T01:00:00Z',
      step: '30s',
    } });
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

  it('forwards compiled regex redaction rules to runPrometheusQuery', async () => {
    runPrometheusQuery.mockResolvedValue('ok');
    const rules: CompiledRedactionRule[] = [{ name: 'token', re: /bearer \S+/gi }];
    const tool = makePrometheusQuery(undefined, rules);
    await tool.run({ input: { queryType: 'instant', query: 'up' } });
    expect(runPrometheusQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ regexRedactionRules: rules }),
    );
  });

  it('forwards regexRedactionRules as undefined when none are provided', async () => {
    runPrometheusQuery.mockResolvedValue('ok');
    const tool = makePrometheusQuery({});
    await tool.run({ input: { queryType: 'instant', query: 'up' } });
    expect(runPrometheusQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ regexRedactionRules: undefined }),
    );
  });
});

describe('prometheusPlugin', () => {
  it('key is "prometheusQuery"', () => {
    expect(prometheusPlugin.key).toBe('prometheusQuery');
  });

  it('factory passes prometheus config and rules through to runPrometheusQuery', async () => {
    runPrometheusQuery.mockResolvedValue('ok');
    const rules: CompiledRedactionRule[] = [{ name: 'secret', re: /AKIA[0-9A-Z]{16}/g }];
    const config = {
      prometheus: { url: 'http://prom-test:9090', timeoutMs: 5000 },
    } as unknown as HeimdallConfig;
    const tool = prometheusPlugin.factory(config, rules);
    await tool.run({ input: { queryType: 'instant', query: 'up' } });
    expect(runPrometheusQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ url: 'http://prom-test:9090', timeoutMs: 5000, regexRedactionRules: rules }),
    );
  });

  it('factory passes namespace lock through to makePrometheusQuery', async () => {
    runPrometheusQuery.mockResolvedValue('ok');
    const config = {
      prometheus: { url: 'http://prom-test:9090' },
      namespace: { locked: 'prod-ns' },
    } as unknown as HeimdallConfig;
    const tool = prometheusPlugin.factory(config, []);
    expect(tool.description).toContain('NAMESPACE LOCKDOWN ACTIVE');
    await tool.run({ input: { queryType: 'instant', query: 'up{namespace="prod-ns"}' } });
    expect(runPrometheusQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ lockedNamespace: 'prod-ns' }),
    );
  });

  it('factory works when namespace.locked is undefined', async () => {
    runPrometheusQuery.mockResolvedValue('ok');
    const config = {
      prometheus: { url: 'http://prom-test:9090' },
    } as unknown as HeimdallConfig;
    const tool = prometheusPlugin.factory(config, []);
    expect(tool.description).not.toContain('NAMESPACE LOCKDOWN');
  });
});
