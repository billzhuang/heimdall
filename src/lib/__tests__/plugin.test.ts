import { describe, it, expect, vi } from 'vitest';
import { buildToolRegistry, type ToolPlugin } from '../plugin.ts';
import type { HeimdallConfig } from '../config.ts';
import type { CompiledRedactionRule } from '../regex-redact.ts';
import type { ToolDefinition } from '@flue/runtime';

const NO_RULES: CompiledRedactionRule[] = [];

function baseTools(): NonNullable<HeimdallConfig['tools']> {
  return {
    kubectl: false,
    listContexts: false,
    listNamespaces: false,
    helmRelease: false,
    prometheusQuery: false,
    awsCli: false,
    trivyScan: false,
    kubecostQuery: false,
    lokiQuery: false,
    jaegerQuery: false,
    datadogQuery: false,
    newRelicQuery: false,
    cdkQuery: false,
  };
}

function makeConfig(toolsOverrides: Partial<NonNullable<HeimdallConfig['tools']>> = {}): HeimdallConfig {
  return { tools: { ...baseTools(), ...toolsOverrides } } as unknown as HeimdallConfig;
}

function makePlugin(key: ToolPlugin['key']): ToolPlugin & { factory: ReturnType<typeof vi.fn> } {
  const tool = { name: key } as unknown as ToolDefinition;
  return { key, factory: vi.fn().mockReturnValue(tool) };
}

describe('buildToolRegistry — empty plugin list', () => {
  it('returns empty allTools and empty enabledKeys', () => {
    const { allTools, enabledKeys } = buildToolRegistry([], makeConfig(), NO_RULES);
    expect(Object.keys(allTools)).toHaveLength(0);
    expect(enabledKeys.size).toBe(0);
  });
});

describe('buildToolRegistry — single plugin', () => {
  it('puts the tool in allTools regardless of whether it is enabled', () => {
    const p = makePlugin('prometheusQuery');
    const { allTools } = buildToolRegistry([p], makeConfig({ prometheusQuery: false }), NO_RULES);
    expect(allTools.prometheusQuery).toBeDefined();
  });

  it('adds the key to enabledKeys when config.tools[key] is true', () => {
    const p = makePlugin('prometheusQuery');
    const { enabledKeys } = buildToolRegistry([p], makeConfig({ prometheusQuery: true }), NO_RULES);
    expect(enabledKeys.has('prometheusQuery')).toBe(true);
  });

  it('does not add the key to enabledKeys when config.tools[key] is false', () => {
    const p = makePlugin('prometheusQuery');
    const { enabledKeys } = buildToolRegistry([p], makeConfig({ prometheusQuery: false }), NO_RULES);
    expect(enabledKeys.has('prometheusQuery')).toBe(false);
  });

  it('passes config and rules to the factory', () => {
    const p = makePlugin('awsCli');
    const config = makeConfig({ awsCli: true });
    const rules: CompiledRedactionRule[] = [{ name: 'secret', re: /secret/gi }];
    buildToolRegistry([p], config, rules);
    expect(p.factory).toHaveBeenCalledWith(config, rules);
  });
});

describe('buildToolRegistry — multiple plugins', () => {
  it('correctly separates enabled from disabled keys', () => {
    const prom = makePlugin('prometheusQuery');
    const aws = makePlugin('awsCli');
    const loki = makePlugin('lokiQuery');
    const config = makeConfig({ prometheusQuery: true, awsCli: false, lokiQuery: true });
    const { allTools, enabledKeys } = buildToolRegistry([prom, aws, loki], config, NO_RULES);

    expect(Object.keys(allTools)).toHaveLength(3);
    expect(enabledKeys.has('prometheusQuery')).toBe(true);
    expect(enabledKeys.has('awsCli')).toBe(false);
    expect(enabledKeys.has('lokiQuery')).toBe(true);
    expect(enabledKeys.size).toBe(2);
  });

  it('calls each factory exactly once', () => {
    const p1 = makePlugin('kubectl');
    const p2 = makePlugin('awsCli');
    buildToolRegistry([p1, p2], makeConfig(), NO_RULES);
    expect(p1.factory).toHaveBeenCalledTimes(1);
    expect(p2.factory).toHaveBeenCalledTimes(1);
  });

  it('stores the ToolDefinition returned by the factory', () => {
    const sentinel = { name: 'sentinel-tool' } as unknown as ToolDefinition;
    const factory = vi.fn().mockReturnValue(sentinel);
    const p: ToolPlugin = { key: 'kubectl', factory };
    const { allTools } = buildToolRegistry([p], makeConfig({ kubectl: true }), NO_RULES);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(allTools.kubectl).toBe(sentinel);
  });
});
