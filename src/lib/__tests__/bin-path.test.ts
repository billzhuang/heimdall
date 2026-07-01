import { describe, it, expect } from 'vitest';
import { resolve, isAbsolute } from 'node:path';
import { resolveBinPath } from '../bin-path.ts';

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
