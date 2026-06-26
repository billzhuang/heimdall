import { describe, it, expect, vi, afterEach } from 'vitest';

const { runJaegerQuery } = vi.hoisted(() => ({ runJaegerQuery: vi.fn() }));
vi.mock('../../lib/jaeger.ts', () => ({ runJaegerQuery }));

import { makeJaegerQuery } from '../jaeger.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  runJaegerQuery.mockReset();
});

describe('makeJaegerQuery — URL precedence', () => {
  it('uses jaegerConfig.url when provided', async () => {
    runJaegerQuery.mockResolvedValue('traces');
    const tool = makeJaegerQuery({ url: 'http://custom-jaeger:16686' });
    await tool.run({ input: { service: 'checkout' } });
    expect(runJaegerQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ url: 'http://custom-jaeger:16686' }),
    );
  });

  it('falls back to JAEGER_URL env when config url is absent', async () => {
    runJaegerQuery.mockResolvedValue('traces');
    vi.stubEnv('JAEGER_URL', 'http://env-jaeger:16686');
    const tool = makeJaegerQuery({});
    await tool.run({ input: { service: 'checkout' } });
    expect(runJaegerQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ url: 'http://env-jaeger:16686' }),
    );
  });

  it('defaults to in-cluster URL when neither config nor env is set', async () => {
    runJaegerQuery.mockResolvedValue('traces');
    vi.stubEnv('JAEGER_URL', '');
    const tool = makeJaegerQuery(null);
    await tool.run({ input: { service: 'checkout' } });
    expect(runJaegerQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ url: 'http://jaeger-query.tracing:16686' }),
    );
  });
});

describe('makeJaegerQuery — timeout precedence', () => {
  it('uses config timeoutMs when provided', async () => {
    runJaegerQuery.mockResolvedValue('traces');
    const tool = makeJaegerQuery({ timeoutMs: 3000 });
    await tool.run({ input: { service: 'checkout' } });
    expect(runJaegerQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: 3000 }),
    );
  });

  it('defaults to 10000ms when timeoutMs is absent', async () => {
    runJaegerQuery.mockResolvedValue('traces');
    const tool = makeJaegerQuery({});
    await tool.run({ input: { service: 'checkout' } });
    expect(runJaegerQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
  });

  it('rejects zero timeoutMs and falls back to default', async () => {
    runJaegerQuery.mockResolvedValue('traces');
    const tool = makeJaegerQuery({ timeoutMs: 0 });
    await tool.run({ input: { service: 'checkout' } });
    expect(runJaegerQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
  });
});

describe('makeJaegerQuery — tool metadata and params forwarding', () => {
  it('has the expected model-facing name', () => {
    expect(makeJaegerQuery().name).toBe('jaeger_query');
  });

  it('forwards all query params to runJaegerQuery', async () => {
    runJaegerQuery.mockResolvedValue('3 traces');
    const tool = makeJaegerQuery({});
    const result = await tool.run({ input: {
      service: 'payments',
      operation: 'POST /charge',
      start: '-1h',
      end: 'now',
      limit: 5,
      minDuration: '500ms',
      tags: 'error=true',
    } });
    expect(result).toBe('3 traces');
    expect(runJaegerQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'payments',
        operation: 'POST /charge',
        limit: 5,
        minDuration: '500ms',
        tags: 'error=true',
      }),
      expect.anything(),
    );
  });
});
