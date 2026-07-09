import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSweepStartupMessages, parseTriageArgs } from '../../triage-mode.ts';

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

  it('exits 1 on -n with a missing value', () => {
    const { status, stderr } = triageMode('-n');
    expect(status).toBe(1);
    expect(stderr).toContain('Error: -n requires a namespace argument\n');
  });

  it('exits 1 on --namespace with a missing value', () => {
    const { status, stderr } = triageMode('--namespace');
    expect(status).toBe(1);
    expect(stderr).toContain('Error: --namespace requires a namespace argument\n');
  });

  it('exits 1 on --namespace= with an empty value', () => {
    const { status, stderr } = triageMode('--namespace=');
    expect(status).toBe(1);
    expect(stderr).toContain('Error: --namespace= requires a non-empty value\n');
  });

  it('exits 1 on --contexts with a missing value', () => {
    const { status, stderr } = triageMode('--contexts');
    expect(status).toBe(1);
    expect(stderr).toContain('Error: --contexts requires a comma-separated list of context names\n');
  });

  it('exits 1 on --contexts= with an empty value', () => {
    const { status, stderr } = triageMode('--contexts=');
    expect(status).toBe(1);
    expect(stderr).toContain('Error: --contexts= requires a non-empty comma-separated list\n');
  });

  it('exits 1 on --contexts with a value that has no non-empty entries', () => {
    const { status, stderr } = triageMode('--contexts', ',,,');
    expect(status).toBe(1);
    expect(stderr).toContain('Error: --contexts value produced an empty list after parsing\n');
  });

  it('exits 1 on --contexts= with a value that has no non-empty entries', () => {
    const { status, stderr } = triageMode('--contexts=,,,');
    expect(status).toBe(1);
    expect(stderr).toContain('Error: --contexts= value produced an empty list after parsing\n');
  });
});

describe('parseTriageArgs', () => {
  it('returns empty opts and undefined modelFlag for no args', () => {
    expect(parseTriageArgs([])).toEqual({ opts: {}, modelFlag: undefined });
  });

  it('parses -n/--namespace and --namespace=<value>', () => {
    expect(parseTriageArgs(['-n', 'prod'])).toEqual({ opts: { namespace: 'prod' }, modelFlag: undefined });
    expect(parseTriageArgs(['--namespace', 'prod'])).toEqual({ opts: { namespace: 'prod' }, modelFlag: undefined });
    expect(parseTriageArgs(['--namespace=prod'])).toEqual({ opts: { namespace: 'prod' }, modelFlag: undefined });
  });

  it('parses -A/--all-namespaces', () => {
    expect(parseTriageArgs(['-A'])).toEqual({ opts: { allNamespaces: true }, modelFlag: undefined });
    expect(parseTriageArgs(['--all-namespaces'])).toEqual({ opts: { allNamespaces: true }, modelFlag: undefined });
  });

  it('parses --contexts and --contexts=<value> into a list', () => {
    expect(parseTriageArgs(['--contexts', 'cluster-a,cluster-b'])).toEqual({
      opts: { contexts: ['cluster-a', 'cluster-b'] },
      modelFlag: undefined,
    });
    expect(parseTriageArgs(['--contexts=cluster-a,cluster-b'])).toEqual({
      opts: { contexts: ['cluster-a', 'cluster-b'] },
      modelFlag: undefined,
    });
  });

  it('parses --model and --model=<value>', () => {
    expect(parseTriageArgs(['--model', 'anthropic/claude-opus-4-8'])).toEqual({
      opts: {},
      modelFlag: 'anthropic/claude-opus-4-8',
    });
    expect(parseTriageArgs(['--model=anthropic/claude-opus-4-8'])).toEqual({
      opts: {},
      modelFlag: 'anthropic/claude-opus-4-8',
    });
  });

  it('parses a combination of flags', () => {
    expect(parseTriageArgs(['-A', '--contexts', 'cluster-a', '--model', 'anthropic/claude-opus-4-8'])).toEqual({
      opts: { allNamespaces: true, contexts: ['cluster-a'] },
      modelFlag: 'anthropic/claude-opus-4-8',
    });
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
