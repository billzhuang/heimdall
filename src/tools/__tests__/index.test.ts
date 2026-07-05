import { describe, it, expect } from 'vitest';
import { ALL_TOOL_PLUGINS } from '../index.ts';

describe('ALL_TOOL_PLUGINS', () => {
  it('lists every built-in tool plugin exactly once, keyed by its config key', () => {
    const keys = ALL_TOOL_PLUGINS.map((p) => p.key);
    expect(keys).toEqual([
      'kubectl',
      'listContexts',
      'listNamespaces',
      'helmRelease',
      'prometheusQuery',
      'awsCli',
      'trivyScan',
      'kubecostQuery',
      'lokiQuery',
      'jaegerQuery',
      'datadogQuery',
      'newRelicQuery',
      'cdkQuery',
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every plugin a callable factory', () => {
    for (const plugin of ALL_TOOL_PLUGINS) {
      expect(typeof plugin.factory).toBe('function');
    }
  });
});
