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
});

describe('SUBAGENT_INSTRUCTIONS', () => {
  it('defines all four read-only specialists', () => {
    expect(Object.keys(SUBAGENT_INSTRUCTIONS).sort()).toEqual([
      'log-analyzer',
      'network-debugger',
      'resource-analyzer',
      'security-auditor',
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
