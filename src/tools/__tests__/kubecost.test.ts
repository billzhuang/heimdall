import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeKubecostQuery, kubecostPlugin } from '../kubecost.ts';
import type { CompiledRedactionRule } from '../../lib/regex-redact.ts';
import type { HeimdallConfig } from '../../lib/config.ts';

function stubOkFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('makeKubecostQuery — config precedence', () => {
  it('uses kubecostConfig.url when provided', async () => {
    const fetchMock = stubOkFetch();
    const tool = makeKubecostQuery({ url: 'http://custom:9090' });
    await tool.run({ input: { endpoint: 'allocation', window: '7d', aggregate: 'namespace' } });
    expect(fetchMock.mock.calls[0][0] as string).toContain('http://custom:9090');
  });

  it('falls back to KUBECOST_URL env var when kubecostConfig.url is absent', async () => {
    const fetchMock = stubOkFetch();
    vi.stubEnv('KUBECOST_URL', 'http://env-kubecost:9090');
    const tool = makeKubecostQuery({});
    await tool.run({ input: { endpoint: 'allocation', window: '7d', aggregate: 'namespace' } });
    expect(fetchMock.mock.calls[0][0] as string).toContain('http://env-kubecost:9090');
  });

  it('falls back to the default in-cluster URL when neither config nor env is set', async () => {
    const fetchMock = stubOkFetch();
    vi.stubEnv('KUBECOST_URL', '');
    const tool = makeKubecostQuery(null);
    await tool.run({ input: { endpoint: 'allocation', window: '7d', aggregate: 'namespace' } });
    expect(fetchMock.mock.calls[0][0] as string).toContain('http://kubecost-cost-analyzer.kubecost:9090');
  });

  it('uses kubecostConfig.timeoutMs when provided', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('abort'), { name: 'AbortError' })),
    );
    const tool = makeKubecostQuery({ timeoutMs: 1 });
    const result = await tool.run({ input: { endpoint: 'allocation', window: '7d', aggregate: 'namespace' } });
    expect(result).toContain('1ms');
  });

  it('falls back to 10 000 ms timeout when timeoutMs is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('abort'), { name: 'AbortError' })),
    );
    const tool = makeKubecostQuery({});
    const result = await tool.run({ input: { endpoint: 'allocation', window: '7d', aggregate: 'namespace' } });
    expect(result).toContain('10000ms');
  });

  it.each([0, -1, Infinity, NaN])('falls back to 10 000 ms when timeoutMs is %s', async (bad) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('abort'), { name: 'AbortError' })),
    );
    const tool = makeKubecostQuery({ timeoutMs: bad });
    const result = await tool.run({ input: { endpoint: 'allocation', window: '7d', aggregate: 'namespace' } });
    expect(result).toContain('10000ms');
  });
});

describe('makeKubecostQuery — namespace lockdown', () => {
  it('includes NAMESPACE LOCKDOWN note in description when lockedNamespace is set', () => {
    const tool = makeKubecostQuery({}, undefined, 'prod-payments');
    expect(tool.description).toContain('NAMESPACE LOCKDOWN ACTIVE');
    expect(tool.description).toContain("'prod-payments'");
  });

  it('description has no lockdown note when lockedNamespace is omitted', () => {
    const tool = makeKubecostQuery({});
    expect(tool.description).not.toContain('NAMESPACE LOCKDOWN');
  });

  it('description has no lockdown note when lockedNamespace is null', () => {
    const tool = makeKubecostQuery({}, undefined, null);
    expect(tool.description).not.toContain('NAMESPACE LOCKDOWN');
  });
});

describe('kubecostPlugin', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('key is "kubecostQuery"', () => {
    expect(kubecostPlugin.key).toBe('kubecostQuery');
  });

  it('factory passes kubecost config, rules, and namespace lock through to makeKubecostQuery', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    const rules: CompiledRedactionRule[] = [{ name: 'token', re: /bearer \S+/gi }];
    const config = {
      kubecost: { url: 'http://kubecost-test:9090', timeoutMs: 5000 },
      namespace: { locked: 'prod-ns' },
    } as unknown as HeimdallConfig;

    const tool = kubecostPlugin.factory(config, rules);

    expect(tool.description).toContain('NAMESPACE LOCKDOWN ACTIVE');
    expect(tool.description).toContain("'prod-ns'");
    await tool.run({ input: { endpoint: 'allocation', window: '7d', aggregate: 'namespace' } });
    expect(fetchMock.mock.calls[0][0] as string).toContain('http://kubecost-test:9090');
  });

  it('factory works when namespace.locked is undefined', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    const config = {
      kubecost: { url: 'http://kubecost:9090' },
    } as unknown as HeimdallConfig;

    const tool = kubecostPlugin.factory(config, []);
    expect(tool.description).not.toContain('NAMESPACE LOCKDOWN');
  });
});
