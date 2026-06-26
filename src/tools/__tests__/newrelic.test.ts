import { describe, it, expect, vi, afterEach } from 'vitest';

const { runNewRelicQuery } = vi.hoisted(() => ({ runNewRelicQuery: vi.fn() }));
vi.mock('../../lib/newrelic.ts', () => ({ runNewRelicQuery }));

import { makeNewRelicQuery } from '../newrelic.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  runNewRelicQuery.mockReset();
});

const BASE_PARAMS = { queryType: 'metrics' as const };

describe('makeNewRelicQuery — apiKey/accountId precedence', () => {
  it('uses config apiKey/accountId over env', async () => {
    runNewRelicQuery.mockResolvedValue('ok');
    vi.stubEnv('NEW_RELIC_API_KEY', 'env-api-key');
    vi.stubEnv('NEW_RELIC_ACCOUNT_ID', 'env-account-id');
    const tool = makeNewRelicQuery({ apiKey: 'cfg-api-key', accountId: 'cfg-account-id' });
    await tool.run({ input: BASE_PARAMS });
    expect(runNewRelicQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ apiKey: 'cfg-api-key', accountId: 'cfg-account-id' }),
    );
  });

  it('falls back to NEW_RELIC_API_KEY env when config apiKey is absent', async () => {
    runNewRelicQuery.mockResolvedValue('ok');
    vi.stubEnv('NEW_RELIC_API_KEY', 'env-api');
    vi.stubEnv('NEW_RELIC_ACCOUNT_ID', 'env-acct');
    const tool = makeNewRelicQuery({});
    await tool.run({ input: BASE_PARAMS });
    expect(runNewRelicQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ apiKey: 'env-api', accountId: 'env-acct' }),
    );
  });

  it('resolves to empty strings when neither config nor env provides credentials', async () => {
    runNewRelicQuery.mockResolvedValue('ok');
    vi.stubEnv('NEW_RELIC_API_KEY', '');
    vi.stubEnv('NEW_RELIC_ACCOUNT_ID', '');
    const tool = makeNewRelicQuery(null);
    await tool.run({ input: BASE_PARAMS });
    expect(runNewRelicQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ apiKey: '', accountId: '' }),
    );
  });
});

describe('makeNewRelicQuery — timeout precedence', () => {
  it('uses config timeoutMs when provided', async () => {
    runNewRelicQuery.mockResolvedValue('ok');
    const tool = makeNewRelicQuery({ timeoutMs: 5000 });
    await tool.run({ input: BASE_PARAMS });
    expect(runNewRelicQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: 5000 }),
    );
  });

  it('defaults to 15000ms when timeoutMs is absent', async () => {
    runNewRelicQuery.mockResolvedValue('ok');
    const tool = makeNewRelicQuery({});
    await tool.run({ input: BASE_PARAMS });
    expect(runNewRelicQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });

  it('rejects zero timeoutMs and falls back to default', async () => {
    runNewRelicQuery.mockResolvedValue('ok');
    const tool = makeNewRelicQuery({ timeoutMs: 0 });
    await tool.run({ input: BASE_PARAMS });
    expect(runNewRelicQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });

  it('rejects negative timeoutMs and falls back to default', async () => {
    runNewRelicQuery.mockResolvedValue('ok');
    const tool = makeNewRelicQuery({ timeoutMs: -500 });
    await tool.run({ input: BASE_PARAMS });
    expect(runNewRelicQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });

  it('rejects non-finite timeoutMs and falls back to default', async () => {
    runNewRelicQuery.mockResolvedValue('ok');
    const tool = makeNewRelicQuery({ timeoutMs: Infinity });
    await tool.run({ input: BASE_PARAMS });
    expect(runNewRelicQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });
});

describe('makeNewRelicQuery — tool metadata', () => {
  it('has the expected model-facing name', () => {
    expect(makeNewRelicQuery().name).toBe('newrelic_query');
  });
});

describe('makeNewRelicQuery — parameter forwarding', () => {
  it('forwards all query params to runNewRelicQuery', async () => {
    runNewRelicQuery.mockResolvedValue('alerts result');
    const tool = makeNewRelicQuery({});
    const result = await tool.run({ input: {
      queryType: 'alerts',
      query: "priority = 'CRITICAL'",
      from: '-1h',
      to: 'now',
      limit: 50,
    } });
    expect(result).toBe('alerts result');
    expect(runNewRelicQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryType: 'alerts',
        query: "priority = 'CRITICAL'",
        from: '-1h',
        to: 'now',
        limit: 50,
      }),
      expect.anything(),
    );
  });

  it('forwards metrics queryType with NRQL query', async () => {
    runNewRelicQuery.mockResolvedValue('metrics result');
    const tool = makeNewRelicQuery({});
    const result = await tool.run({ input: {
      queryType: 'metrics',
      query: 'SELECT average(cpuPercent) FROM SystemSample SINCE 1 hour ago',
    } });
    expect(result).toBe('metrics result');
    expect(runNewRelicQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryType: 'metrics',
        query: 'SELECT average(cpuPercent) FROM SystemSample SINCE 1 hour ago',
      }),
      expect.anything(),
    );
  });

  it('returns the value from runNewRelicQuery verbatim', async () => {
    runNewRelicQuery.mockResolvedValue('raw tool output');
    const tool = makeNewRelicQuery({});
    expect(await tool.run({ input: BASE_PARAMS })).toBe('raw tool output');
  });
});
