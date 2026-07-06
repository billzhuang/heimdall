import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as v from 'valibot';

const { runHelm } = vi.hoisted(() => ({ runHelm: vi.fn() }));
vi.mock('../../lib/helm.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  runHelm,
}));

import { makeHelmRelease, helmRelease, helmReleasePlugin } from '../helm.ts';
import type { HeimdallConfig } from '../../lib/config.ts';

beforeEach(() => runHelm.mockReset());

describe('makeHelmRelease', () => {
  it('tool name is helm_release', () => {
    expect(makeHelmRelease().name).toBe('helm_release');
  });

  it('singleton export has correct name', () => {
    expect(helmRelease.name).toBe('helm_release');
  });

  it('forwards list action to runHelm', async () => {
    runHelm.mockResolvedValue('NAME  NAMESPACE  STATUS  CHART  APP VERSION  DEPLOYED');
    const tool = makeHelmRelease();
    const result = await tool.run({ input: { action: 'list' } });
    expect(result).toContain('NAME');
    expect(runHelm).toHaveBeenCalledWith('list', expect.objectContaining({ allNamespaces: undefined }));
  });
});

describe('makeHelmRelease — namespace lockdown', () => {
  it('blocks allNamespaces when lockdown is active', async () => {
    const tool = makeHelmRelease('prod-payments');
    const result = await tool.run({ input: { action: 'list', allNamespaces: true } });
    expect(result).toMatch(/BLOCKED/i);
    expect(result).toContain("allNamespaces");
    expect(runHelm).not.toHaveBeenCalled();
  });

  it('blocks wrong namespace when lockdown is active', async () => {
    const tool = makeHelmRelease('prod-payments');
    const result = await tool.run({ input: { action: 'list', namespace: 'other-namespace' } });
    expect(result).toMatch(/BLOCKED/i);
    expect(result).toContain('other-namespace');
    expect(runHelm).not.toHaveBeenCalled();
  });

  it('allows correct locked namespace and enforces it', async () => {
    runHelm.mockResolvedValue('releases...');
    const tool = makeHelmRelease('prod-payments');
    const result = await tool.run({ input: { action: 'list', namespace: 'prod-payments' } });
    expect(result).toBe('releases...');
    expect(runHelm).toHaveBeenCalledWith(
      'list',
      expect.objectContaining({ namespace: 'prod-payments', allNamespaces: false }),
    );
  });

  it('fills in locked namespace when none is provided', async () => {
    runHelm.mockResolvedValue('releases...');
    const tool = makeHelmRelease('prod-payments');
    await tool.run({ input: { action: 'list' } });
    expect(runHelm).toHaveBeenCalledWith(
      'list',
      expect.objectContaining({ namespace: 'prod-payments' }),
    );
  });

  it('description mentions lockdown when active', () => {
    const tool = makeHelmRelease('prod-payments');
    expect(tool.description).toContain('NAMESPACE LOCKDOWN ACTIVE');
    expect(tool.description).toContain('prod-payments');
  });

  it('description has no lockdown note when no lock is set', () => {
    const tool = makeHelmRelease();
    expect(tool.description).not.toContain('NAMESPACE LOCKDOWN');
  });
});

describe('makeHelmRelease — input schema picklists', () => {
  it('action accepts exactly list/status/get', () => {
    for (const action of ['list', 'status', 'get']) {
      expect(v.safeParse(helmRelease.input, { action }).success).toBe(true);
    }
    expect(v.safeParse(helmRelease.input, { action: 'uninstall' }).success).toBe(false);
  });

  it('getType accepts exactly values/manifest/notes', () => {
    for (const getType of ['values', 'manifest', 'notes']) {
      expect(v.safeParse(helmRelease.input, { action: 'get', getType }).success).toBe(true);
    }
    expect(v.safeParse(helmRelease.input, { action: 'get', getType: 'crds' }).success).toBe(false);
  });
});

describe('helmReleasePlugin', () => {
  it('key is "helmRelease"', () => {
    expect(helmReleasePlugin.key).toBe('helmRelease');
  });

  it('factory passes namespace.locked through to makeHelmRelease', async () => {
    runHelm.mockResolvedValue('ok');
    const config = {
      namespace: { locked: 'prod-ns' },
    } as unknown as HeimdallConfig;
    const tool = helmReleasePlugin.factory(config, []);
    expect(tool.description).toContain('NAMESPACE LOCKDOWN ACTIVE');
    expect(tool.description).toContain('prod-ns');
    await tool.run({ input: { action: 'list', namespace: 'prod-ns' } });
    expect(runHelm).toHaveBeenCalledWith('list', expect.objectContaining({ namespace: 'prod-ns' }));
  });

  it('factory works when namespace.locked is undefined', () => {
    const config = {} as unknown as HeimdallConfig;
    const tool = helmReleasePlugin.factory(config, []);
    expect(tool.description).not.toContain('NAMESPACE LOCKDOWN');
  });
});
