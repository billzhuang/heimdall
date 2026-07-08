/**
 * Characterization test for alert-mode's CLI entry point, run out-of-process
 * via tsx so the top-level arg-parsing block executes exactly as it does for
 * `npm run alert` / `heimdall alert`. Kept separate from alert-mode.test.ts
 * because that file mocks node:child_process for in-process runAgent tests.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');
const ENTRY = resolve(ROOT, 'src/alert-mode.ts');

function alertMode(...args: string[]) {
  const result = spawnSync(TSX, [ENTRY, ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  return result;
}

describe('heimdall alert CLI', () => {
  it('exits 1 on an unknown option', () => {
    const { status, stderr } = alertMode('--bogus');
    expect(status).toBe(1);
    expect(stderr).toContain('Error: unknown option: --bogus\n');
  });
});
