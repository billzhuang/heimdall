import { afterEach, describe, it, expect } from 'vitest';
import { SUBAGENT_INSTRUCTIONS, buildInstructions } from '../instructions.ts';
import { DEFAULT_MODEL } from '../model.ts';

const ENV_KEYS = ['HEIMDALL_CONTEXT', 'HEIMDALL_NAMESPACE'] as const;

function withEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => void) {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, val] of Object.entries(overrides)) process.env[k] = val;
    fn();
  } finally {
    for (const [k, val] of saved) {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    }
  }
}

describe('buildInstructions', () => {
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it('always describes the agent, its tools, the read-only policy, and the response format', () => {
    withEnv({}, () => {
      const out = buildInstructions();
      expect(out).toMatch(/You are Heimdall/);
      expect(out).toMatch(/`kubectl`/);
      expect(out).toMatch(/`list_contexts`/);
      expect(out).toMatch(/`list_namespaces`/);
      expect(out).toMatch(/READ-ONLY/);
      expect(out).toMatch(/Thinking Summary:/);
      expect(out).toMatch(/Answer:/);
      // every specialist subagent is advertised for delegation
      for (const name of Object.keys(SUBAGENT_INSTRUCTIONS)) {
        expect(out).toContain(name);
      }
    });
  });

  it('uses discovery guidance when no context/namespace is pinned', () => {
    withEnv({}, () => {
      const out = buildInstructions();
      expect(out).toMatch(/No context is pinned/);
      expect(out).toMatch(/No namespace is pinned/);
    });
  });

  it('pins the context and namespace from the environment when set', () => {
    withEnv({ HEIMDALL_CONTEXT: 'prod-eks', HEIMDALL_NAMESPACE: 'payments' }, () => {
      const out = buildInstructions();
      expect(out).toMatch(/Default cluster context: prod-eks/);
      expect(out).toMatch(/Default namespace: payments/);
      expect(out).toMatch(/-n payments/);
      expect(out).not.toMatch(/No context is pinned/);
    });
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
