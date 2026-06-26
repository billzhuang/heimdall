import { describe, it, expect, vi, afterEach } from 'vitest';

const { runDatadogQuery } = vi.hoisted(() => ({ runDatadogQuery: vi.fn() }));
vi.mock('../../lib/datadog.ts', () => ({ runDatadogQuery }));

import { makeDatadogQuery, datadogPlugin } from '../datadog.ts';
import type { CompiledRedactionRule } from '../../lib/regex-redact.ts';
import type { HeimdallConfig } from '../../lib/config.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  runDatadogQuery.mockReset();
});

const BASE_PARAMS = { queryType: 'metrics' as const };

describe('makeDatadogQuery — apiKey/appKey precedence', () => {
  it('uses config apiKey/appKey over env', async () => {
    runDatadogQuery.mockResolvedValue('ok');
    vi.stubEnv('DD_API_KEY', 'env-api-key');
    const tool = makeDatadogQuery({ apiKey: 'cfg-api-key', appKey: 'cfg-app-key' });
    await tool.run({ input: BASE_PARAMS });
    expect(runDatadogQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ apiKey: 'cfg-api-key', appKey: 'cfg-app-key' }),
    );
  });

  it('falls back to DD_API_KEY env when config apiKey is absent', async () => {
    runDatadogQuery.mockResolvedValue('ok');
    vi.stubEnv('DD_API_KEY', 'env-api');
    vi.stubEnv('DD_APP_KEY', 'env-app');
    const tool = makeDatadogQuery({});
    await tool.run({ input: BASE_PARAMS });
    expect(runDatadogQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ apiKey: 'env-api', appKey: 'env-app' }),
    );
  });

  it('falls back to DATADOG_API_KEY env as secondary alias', async () => {
    runDatadogQuery.mockResolvedValue('ok');
    vi.stubEnv('DD_API_KEY', '');
    vi.stubEnv('DATADOG_API_KEY', 'alias-api');
    vi.stubEnv('DATADOG_APP_KEY', 'alias-app');
    const tool = makeDatadogQuery({});
    await tool.run({ input: BASE_PARAMS });
    expect(runDatadogQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ apiKey: 'alias-api', appKey: 'alias-app' }),
    );
  });
});

describe('makeDatadogQuery — site precedence', () => {
  it('uses config site when provided', async () => {
    runDatadogQuery.mockResolvedValue('ok');
    const tool = makeDatadogQuery({ site: 'datadoghq.eu' });
    await tool.run({ input: BASE_PARAMS });
    expect(runDatadogQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ site: 'datadoghq.eu' }),
    );
  });

  it('falls back to DD_SITE env when config site is absent', async () => {
    runDatadogQuery.mockResolvedValue('ok');
    vi.stubEnv('DD_SITE', 'us3.datadoghq.com');
    const tool = makeDatadogQuery({});
    await tool.run({ input: BASE_PARAMS });
    expect(runDatadogQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ site: 'us3.datadoghq.com' }),
    );
  });

  it('defaults to datadoghq.com when neither config nor env is set', async () => {
    runDatadogQuery.mockResolvedValue('ok');
    vi.stubEnv('DD_SITE', '');
    const tool = makeDatadogQuery(null);
    await tool.run({ input: BASE_PARAMS });
    expect(runDatadogQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ site: 'datadoghq.com' }),
    );
  });
});

describe('makeDatadogQuery — timeout precedence', () => {
  it('uses config timeoutMs when provided', async () => {
    runDatadogQuery.mockResolvedValue('ok');
    const tool = makeDatadogQuery({ timeoutMs: 5000 });
    await tool.run({ input: BASE_PARAMS });
    expect(runDatadogQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: 5000 }),
    );
  });

  it('defaults to 15000ms when timeoutMs is absent', async () => {
    runDatadogQuery.mockResolvedValue('ok');
    const tool = makeDatadogQuery({});
    await tool.run({ input: BASE_PARAMS });
    expect(runDatadogQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });

  it('rejects zero or negative timeoutMs and falls back to default', async () => {
    runDatadogQuery.mockResolvedValue('ok');
    const tool = makeDatadogQuery({ timeoutMs: 0 });
    await tool.run({ input: BASE_PARAMS });
    expect(runDatadogQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });
});

describe('makeDatadogQuery — tool metadata', () => {
  it('has the expected model-facing name', () => {
    expect(makeDatadogQuery().name).toBe('datadog_query');
  });

  it('forwards all query params to runDatadogQuery', async () => {
    runDatadogQuery.mockResolvedValue('metrics result');
    const tool = makeDatadogQuery({});
    const result = await tool.run({ input: {
      queryType: 'logs',
      query: 'service:payments status:error',
      from: '-1h',
      to: 'now',
      limit: 50,
    } });
    expect(result).toBe('metrics result');
    expect(runDatadogQuery).toHaveBeenCalledWith(
      expect.objectContaining({ queryType: 'logs', query: 'service:payments status:error', limit: 50 }),
      expect.anything(),
    );
  });

  it('forwards compiled regex redaction rules to runDatadogQuery', async () => {
    runDatadogQuery.mockResolvedValue('ok');
    const rules: CompiledRedactionRule[] = [{ name: 'token', re: /bearer \S+/gi }];
    const tool = makeDatadogQuery(undefined, rules);
    await tool.run({ input: BASE_PARAMS });
    expect(runDatadogQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ regexRedactionRules: rules }),
    );
  });

  it('forwards regexRedactionRules as undefined when none are provided', async () => {
    runDatadogQuery.mockResolvedValue('ok');
    const tool = makeDatadogQuery({});
    await tool.run({ input: BASE_PARAMS });
    expect(runDatadogQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ regexRedactionRules: undefined }),
    );
  });
});

describe('datadogPlugin', () => {
  it('key is "datadogQuery"', () => {
    expect(datadogPlugin.key).toBe('datadogQuery');
  });

  it('factory passes datadog config and rules through to runDatadogQuery', async () => {
    runDatadogQuery.mockResolvedValue('ok');
    const rules: CompiledRedactionRule[] = [{ name: 'secret', re: /AKIA[0-9A-Z]{16}/g }];
    const config = {
      datadog: { apiKey: 'test-api', appKey: 'test-app', site: 'datadoghq.eu', timeoutMs: 5000 },
    } as unknown as HeimdallConfig;
    const tool = datadogPlugin.factory(config, rules);
    await tool.run({ input: BASE_PARAMS });
    expect(runDatadogQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ apiKey: 'test-api', appKey: 'test-app', site: 'datadoghq.eu', timeoutMs: 5000, regexRedactionRules: rules }),
    );
  });
});
