import { describe, it, expect } from 'vitest';
import { resolve, isAbsolute } from 'node:path';
import { resolveBinPath, buildAgentEnv } from '../bin-path.ts';

describe('resolveBinPath', () => {
  it('resolves to <project-root>/bin/heimdall relative to a src/ subdirectory', () => {
    const srcDir = '/some/project/src/lib';
    const binPath = resolveBinPath(srcDir);
    expect(binPath).toBe(resolve('/some/project/src/lib', '..', 'bin', 'heimdall'));
  });

  it('produces an absolute path', () => {
    const binPath = resolveBinPath('/absolute/src/path');
    expect(isAbsolute(binPath)).toBe(true);
  });
});

describe('buildAgentEnv', () => {
  it('overrides HEIMDALL_MODEL when a model is given', () => {
    const env = buildAgentEnv('anthropic/claude-sonnet-4-6');
    expect(env['HEIMDALL_MODEL']).toBe('anthropic/claude-sonnet-4-6');
    expect(env['PATH']).toBe(process.env['PATH']);
  });

  it('returns process.env unchanged when no model is given', () => {
    expect(buildAgentEnv()).toBe(process.env);
    expect(buildAgentEnv('')).toBe(process.env);
  });
});
