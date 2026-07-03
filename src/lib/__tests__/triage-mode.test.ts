import { describe, it, expect } from 'vitest';
import { buildSweepStartupMessages } from '../../triage-mode.ts';

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
