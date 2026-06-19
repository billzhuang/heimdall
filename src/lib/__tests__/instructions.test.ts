import { describe, it, expect } from 'vitest';
import { SUBAGENT_INSTRUCTIONS, buildInstructions } from '../instructions.ts';
import { DEFAULT_MODEL } from '../model.ts';

describe('buildInstructions', () => {
  it('describes the agent, its tools, the read-only policy, and the response format', () => {
    const out = buildInstructions();
    expect(out).toMatch(/You are Heimdall/);
    expect(out).toMatch(/`kubectl`/);
    expect(out).toMatch(/`list_contexts`/);
    expect(out).toMatch(/`list_namespaces`/);
    expect(out).toMatch(/READ-ONLY/);
    expect(out).toMatch(/Thinking Summary:/);
    expect(out).toMatch(/Answer:/);
    for (const name of Object.keys(SUBAGENT_INSTRUCTIONS)) {
      expect(out).toContain(name);
    }
  });

  it('always uses dynamic discovery guidance (no pinned context or namespace)', () => {
    const out = buildInstructions();
    expect(out).toMatch(/No context is pinned/);
    expect(out).toMatch(/No namespace is pinned/);
  });

  it('omits list_contexts references when listContexts is disabled', () => {
    const out = buildInstructions(new Set(['kubectl', 'listNamespaces']));
    expect(out).not.toMatch(/`list_contexts`/);
    expect(out).not.toMatch(/No context is pinned/);
    expect(out).toMatch(/`list_namespaces`/);
    expect(out).toMatch(/No namespace is pinned/);
    expect(out).toMatch(/`kubectl`/);
  });

  it('omits list_namespaces references when listNamespaces is disabled', () => {
    const out = buildInstructions(new Set(['kubectl', 'listContexts']));
    expect(out).not.toMatch(/`list_namespaces`/);
    expect(out).not.toMatch(/No namespace is pinned/);
    expect(out).toMatch(/`list_contexts`/);
    expect(out).toMatch(/No context is pinned/);
    expect(out).toMatch(/`kubectl`/);
  });

  it('omits the Connection section entirely when both discovery tools are disabled', () => {
    const out = buildInstructions(new Set(['kubectl']));
    expect(out).not.toMatch(/## Connection/);
    expect(out).not.toMatch(/`list_contexts`/);
    expect(out).not.toMatch(/`list_namespaces`/);
    expect(out).toMatch(/`kubectl`/);
  });

  it('treats no enabledTools argument as all-enabled (backwards compatibility)', () => {
    const allEnabled = buildInstructions();
    const explicit = buildInstructions(new Set(['kubectl', 'listContexts', 'listNamespaces', 'helmRelease']));
    expect(allEnabled).toBe(explicit);
  });

  it('includes helm_release tool description when helmRelease is enabled', () => {
    const out = buildInstructions(new Set(['kubectl', 'listContexts', 'listNamespaces', 'helmRelease']));
    expect(out).toMatch(/`helm_release`/);
  });

  it('omits helm_release when helmRelease is disabled', () => {
    const out = buildInstructions(new Set(['kubectl', 'listContexts', 'listNamespaces']));
    expect(out).not.toMatch(/`helm_release`/);
  });
});

describe('SUBAGENT_INSTRUCTIONS', () => {
  it('defines all seven specialists', () => {
    expect(Object.keys(SUBAGENT_INSTRUCTIONS).sort()).toEqual([
      'crashloop-analyzer',
      'log-analyzer',
      'network-debugger',
      'oomkill-analyzer',
      'resource-analyzer',
      'security-auditor',
      'triage',
    ]);
  });

  it('reiterates the read-only policy in every subagent prompt', () => {
    for (const text of Object.values(SUBAGENT_INSTRUCTIONS)) {
      expect(text).toMatch(/read-only/i);
      expect(text).toMatch(/Thinking Summary/);
    }
  });
});

describe('DEFAULT_MODEL', () => {
  it('is a provider/model specifier', () => {
    expect(DEFAULT_MODEL).toMatch(/.+\/.+/);
  });
});
