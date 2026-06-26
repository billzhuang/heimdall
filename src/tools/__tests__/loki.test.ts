import { describe, it, expect, vi, afterEach } from 'vitest';

const { runLokiQuery } = vi.hoisted(() => ({ runLokiQuery: vi.fn() }));
vi.mock('../../lib/loki.ts', () => ({ runLokiQuery }));

import { makeLokiQuery, lokiPlugin } from '../loki.ts';
import type { CompiledRedactionRule } from '../../lib/regex-redact.ts';
import type { HeimdallConfig } from '../../lib/config.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  runLokiQuery.mockReset();
});

describe('makeLokiQuery — URL precedence', () => {
  it('uses lokiConfig.url when provided', async () => {
    runLokiQuery.mockResolvedValue('log lines');
    const tool = makeLokiQuery({ url: 'http://custom-loki:3100' });
    await tool.run({ input: { query: '{namespace="prod"}' } });
    expect(runLokiQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ url: 'http://custom-loki:3100' }),
    );
  });

  it('falls back to LOKI_URL env when config url is absent', async () => {
    runLokiQuery.mockResolvedValue('log lines');
    vi.stubEnv('LOKI_URL', 'http://env-loki:3100');
    const tool = makeLokiQuery({});
    await tool.run({ input: { query: '{namespace="prod"}' } });
    expect(runLokiQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ url: 'http://env-loki:3100' }),
    );
  });

  it('defaults to in-cluster URL when neither config nor env is set', async () => {
    runLokiQuery.mockResolvedValue('log lines');
    vi.stubEnv('LOKI_URL', '');
    const tool = makeLokiQuery(null);
    await tool.run({ input: { query: '{namespace="prod"}' } });
    expect(runLokiQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ url: 'http://loki.monitoring:3100' }),
    );
  });
});

describe('makeLokiQuery — timeout precedence', () => {
  it('uses config timeoutMs when provided', async () => {
    runLokiQuery.mockResolvedValue('ok');
    const tool = makeLokiQuery({ timeoutMs: 5000 });
    await tool.run({ input: { query: '{app="api"}' } });
    expect(runLokiQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: 5000 }),
    );
  });

  it('defaults to 15000ms when timeoutMs is absent', async () => {
    runLokiQuery.mockResolvedValue('ok');
    const tool = makeLokiQuery({});
    await tool.run({ input: { query: '{app="api"}' } });
    expect(runLokiQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });

  it('rejects zero timeoutMs and falls back to default', async () => {
    runLokiQuery.mockResolvedValue('ok');
    const tool = makeLokiQuery({ timeoutMs: 0 });
    await tool.run({ input: { query: '{app="api"}' } });
    expect(runLokiQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });
});

describe('makeLokiQuery — namespace lockdown', () => {
  it('bakes lockedNamespace into the config passed to runLokiQuery', async () => {
    runLokiQuery.mockResolvedValue('ok');
    const tool = makeLokiQuery({}, undefined, 'prod-payments');
    await tool.run({ input: { query: '{namespace="prod-payments"}' } });
    expect(runLokiQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lockedNamespace: 'prod-payments' }),
    );
  });

  it('description mentions lockdown when active', () => {
    const tool = makeLokiQuery({}, undefined, 'prod-payments');
    expect(tool.description).toContain('NAMESPACE LOCKDOWN ACTIVE');
    expect(tool.description).toContain('prod-payments');
  });

  it('description has no lockdown note when no lock is set', () => {
    const tool = makeLokiQuery();
    expect(tool.description).not.toContain('NAMESPACE LOCKDOWN');
  });
});

describe('makeLokiQuery — tool metadata and params forwarding', () => {
  it('has the expected model-facing name', () => {
    expect(makeLokiQuery().name).toBe('loki_query');
  });

  it('forwards query params to runLokiQuery', async () => {
    runLokiQuery.mockResolvedValue('100 lines');
    const tool = makeLokiQuery({});
    const result = await tool.run({ input: {
      query: '{namespace="prod", app="api"} |= "ERROR"',
      start: '-2h',
      end: '-1h',
      limit: 200,
    } });
    expect(result).toBe('100 lines');
    expect(runLokiQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query: '{namespace="prod", app="api"} |= "ERROR"',
        start: '-2h',
        end: '-1h',
        limit: 200,
      }),
      expect.anything(),
    );
  });

  it('forwards compiled regex redaction rules to runLokiQuery', async () => {
    runLokiQuery.mockResolvedValue('ok');
    const rules: CompiledRedactionRule[] = [{ name: 'token', re: /bearer \S+/gi }];
    const tool = makeLokiQuery(undefined, rules);
    await tool.run({ input: { query: '{app="api"}' } });
    expect(runLokiQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ regexRedactionRules: rules }),
    );
  });

  it('forwards regexRedactionRules as undefined when none are provided', async () => {
    runLokiQuery.mockResolvedValue('ok');
    const tool = makeLokiQuery({});
    await tool.run({ input: { query: '{app="api"}' } });
    expect(runLokiQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ regexRedactionRules: undefined }),
    );
  });
});

describe('lokiPlugin', () => {
  it('key is "lokiQuery"', () => {
    expect(lokiPlugin.key).toBe('lokiQuery');
  });

  it('factory passes loki config, rules, and namespace lock through to makeLokiQuery', async () => {
    runLokiQuery.mockResolvedValue('ok');
    const rules: CompiledRedactionRule[] = [{ name: 'secret', re: /AKIA[0-9A-Z]{16}/g }];
    const config = {
      loki: { url: 'http://loki-test:3100', timeoutMs: 5000 },
      namespace: { locked: 'prod-ns' },
    } as unknown as HeimdallConfig;
    const tool = lokiPlugin.factory(config, rules);
    expect(tool.description).toContain('NAMESPACE LOCKDOWN ACTIVE');
    await tool.run({ input: { query: '{namespace="prod-ns"}' } });
    expect(runLokiQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ url: 'http://loki-test:3100', timeoutMs: 5000, regexRedactionRules: rules, lockedNamespace: 'prod-ns' }),
    );
  });

  it('factory works when namespace.locked is undefined', async () => {
    runLokiQuery.mockResolvedValue('ok');
    const config = {
      loki: { url: 'http://loki:3100' },
    } as unknown as HeimdallConfig;
    const tool = lokiPlugin.factory(config, []);
    expect(tool.description).not.toContain('NAMESPACE LOCKDOWN');
  });
});
