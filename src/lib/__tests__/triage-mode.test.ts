import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSweepStartupMessages } from '../../triage-mode.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');
const ENTRY = resolve(ROOT, 'src/triage-mode.ts');

function triageMode(...args: string[]) {
  const result = spawnSync(TSX, [ENTRY, ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  return result;
}

describe('heimdall triage CLI', () => {
  it('exits 1 on an unknown option', () => {
    const { status, stderr } = triageMode('--bogus');
    expect(status).toBe(1);
    expect(stderr).toContain('Error: unknown option: --bogus\n');
  });
});

describe('buildSweepStartupMessages', () => {
  it('reports a single-cluster sweep with no scope when namespace/allNamespaces are unset', () => {
    expect(buildSweepStartupMessages({})).toEqual([
      '[heimdall-triage] Starting cluster health sweep...',
    ]);
  });

  it('reports a single-cluster sweep scoped to a namespace', () => {
    expect(buildSweepStartupMessages({ namespace: 'prod' })).toEqual([
      '[heimdall-triage] Starting cluster health sweep...',
      '[heimdall-triage] Scope: namespace "prod"',
    ]);
  });

  it('reports a single-cluster sweep scoped to all namespaces', () => {
    expect(buildSweepStartupMessages({ allNamespaces: true })).toEqual([
      '[heimdall-triage] Starting cluster health sweep...',
      '[heimdall-triage] Scope: all namespaces',
    ]);
  });

  it('prefers namespace over allNamespaces when both are set', () => {
    expect(buildSweepStartupMessages({ namespace: 'prod', allNamespaces: true })).toEqual([
      '[heimdall-triage] Starting cluster health sweep...',
      '[heimdall-triage] Scope: namespace "prod"',
    ]);
  });

  it('reports a multi-cluster sweep with no scope when namespace/allNamespaces are unset', () => {
    expect(buildSweepStartupMessages({ contexts: ['cluster-a', 'cluster-b'] })).toEqual([
      '[heimdall-triage] Starting multi-cluster sweep across: cluster-a, cluster-b',
    ]);
  });

  it('reports a multi-cluster sweep scoped to a namespace', () => {
    expect(buildSweepStartupMessages({ contexts: ['cluster-a'], namespace: 'prod' })).toEqual([
      '[heimdall-triage] Starting multi-cluster sweep across: cluster-a',
      '[heimdall-triage] Scope: namespace "prod"',
    ]);
  });

  it('reports a multi-cluster sweep scoped to all namespaces', () => {
    expect(buildSweepStartupMessages({ contexts: ['cluster-a'], allNamespaces: true })).toEqual([
      '[heimdall-triage] Starting multi-cluster sweep across: cluster-a',
      '[heimdall-triage] Scope: all namespaces',
    ]);
  });

  it('treats an empty contexts array as single-cluster', () => {
    expect(buildSweepStartupMessages({ contexts: [] })).toEqual([
      '[heimdall-triage] Starting cluster health sweep...',
    ]);
  });
});
