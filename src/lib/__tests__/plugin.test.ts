import { describe, it, expect, vi } from 'vitest';
import type { ToolDefinition } from '@flue/runtime';
import { buildToolRegistry, type ToolPlugin } from '../plugin.ts';
import type { HeimdallConfig } from '../config.ts';
import type { CompiledRedactionRule } from '../regex-redact.ts';

// buildToolRegistry only reads config.tools[key]; other HeimdallConfig fields are irrelevant here.
function makeConfig(toolOverrides: Partial<NonNullable<HeimdallConfig['tools']>> = {}): HeimdallConfig {
  return {
    tools: {
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
      ...toolOverrides,
    },
  } as HeimdallConfig;
}

function makePlugin(key: ToolPlugin['key']): ToolPlugin {
  const definition = { name: key, description: `${key} tool` } as ToolDefinition;
  return { key, factory: vi.fn().mockReturnValue(definition) };
}

describe('buildToolRegistry', () => {
  it('returns empty allTools and enabledKeys for an empty plugins array', () => {
    const { allTools, enabledKeys } = buildToolRegistry([], makeConfig(), []);
    expect(Object.keys(allTools)).toHaveLength(0);
    expect(enabledKeys.size).toBe(0);
  });

  it('calls each plugin factory exactly once with the config and rules', () => {
    const rules: CompiledRedactionRule[] = [];
    const config = makeConfig({ kubectl: true });
    const plugin = makePlugin('kubectl');
    buildToolRegistry([plugin], config, rules);
    expect(plugin.factory).toHaveBeenCalledOnce();
    expect(plugin.factory).toHaveBeenCalledWith(config, rules);
  });

  it('populates allTools with the result returned by each factory', () => {
    const config = makeConfig({ kubectl: false });
    const plugin = makePlugin('kubectl');
    const { allTools } = buildToolRegistry([plugin], config, []);
    expect(allTools['kubectl']).toEqual({ name: 'kubectl', description: 'kubectl tool' });
  });

  it('adds the key to enabledKeys when config.tools[key] is true', () => {
    const config = makeConfig({ kubectl: true });
    const { enabledKeys } = buildToolRegistry([makePlugin('kubectl')], config, []);
    expect(enabledKeys.has('kubectl')).toBe(true);
  });

  it('does not add the key to enabledKeys when config.tools[key] is false', () => {
    const config = makeConfig({ kubectl: false });
    const { enabledKeys } = buildToolRegistry([makePlugin('kubectl')], config, []);
    expect(enabledKeys.has('kubectl')).toBe(false);
  });

  it('populates allTools regardless of whether the tool is enabled', () => {
    const config = makeConfig({ kubectl: false });
    const { allTools, enabledKeys } = buildToolRegistry([makePlugin('kubectl')], config, []);
    expect('kubectl' in allTools).toBe(true);
    expect(enabledKeys.has('kubectl')).toBe(false);
  });

  it('handles multiple plugins and correctly splits enabled vs disabled', () => {
    const config = makeConfig({ kubectl: true, awsCli: false, trivyScan: true });
    const plugins = [makePlugin('kubectl'), makePlugin('awsCli'), makePlugin('trivyScan')];
    const { allTools, enabledKeys } = buildToolRegistry(plugins, config, []);
    expect(Object.keys(allTools)).toHaveLength(3);
    expect(enabledKeys.has('kubectl')).toBe(true);
    expect(enabledKeys.has('awsCli')).toBe(false);
    expect(enabledKeys.has('trivyScan')).toBe(true);
    expect(enabledKeys.size).toBe(2);
  });

  it('passes the same rules array to every factory', () => {
    const rules: CompiledRedactionRule[] = [{ name: 'test-rule', re: /secret/ }];
    const config = makeConfig({ kubectl: true, awsCli: true });
    const p1 = makePlugin('kubectl');
    const p2 = makePlugin('awsCli');
    buildToolRegistry([p1, p2], config, rules);
    expect(p1.factory).toHaveBeenCalledWith(config, rules);
    expect(p2.factory).toHaveBeenCalledWith(config, rules);
  });

  it('preserves insertion order in allTools', () => {
    const config = makeConfig({ kubectl: true, awsCli: true, trivyScan: true });
    const plugins = [makePlugin('kubectl'), makePlugin('awsCli'), makePlugin('trivyScan')];
    const { allTools } = buildToolRegistry(plugins, config, []);
    expect(Object.keys(allTools)).toEqual(['kubectl', 'awsCli', 'trivyScan']);
  });
});
