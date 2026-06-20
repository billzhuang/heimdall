import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeKubecostQuery } from '../kubecost.ts';

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
    await tool.execute({ endpoint: 'allocation', window: '7d', aggregate: 'namespace' });
    expect(fetchMock.mock.calls[0][0] as string).toContain('http://custom:9090');
  });

  it('falls back to KUBECOST_URL env var when kubecostConfig.url is absent', async () => {
    const fetchMock = stubOkFetch();
    vi.stubEnv('KUBECOST_URL', 'http://env-kubecost:9090');
    const tool = makeKubecostQuery({});
    await tool.execute({ endpoint: 'allocation', window: '7d', aggregate: 'namespace' });
    expect(fetchMock.mock.calls[0][0] as string).toContain('http://env-kubecost:9090');
  });

  it('falls back to the default in-cluster URL when neither config nor env is set', async () => {
    const fetchMock = stubOkFetch();
    vi.stubEnv('KUBECOST_URL', '');
    const tool = makeKubecostQuery(null);
    await tool.execute({ endpoint: 'allocation', window: '7d', aggregate: 'namespace' });
    expect(fetchMock.mock.calls[0][0] as string).toContain('http://kubecost-cost-analyzer.kubecost:9090');
  });

  it('uses kubecostConfig.timeoutMs when provided', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('abort'), { name: 'AbortError' })),
    );
    const tool = makeKubecostQuery({ timeoutMs: 1 });
    const result = await tool.execute({ endpoint: 'allocation', window: '7d', aggregate: 'namespace' });
    expect(result).toContain('1ms');
  });

  it('falls back to 10 000 ms timeout when timeoutMs is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('abort'), { name: 'AbortError' })),
    );
    const tool = makeKubecostQuery({});
    const result = await tool.execute({ endpoint: 'allocation', window: '7d', aggregate: 'namespace' });
    expect(result).toContain('10000ms');
  });
});
