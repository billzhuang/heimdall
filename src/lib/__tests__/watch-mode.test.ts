/**
 * Characterization tests for watch-mode's CLI entry point, run out-of-process
 * via tsx so the top-level arg-parsing block executes exactly as it does for
 * `npm run watch` / `heimdall --watch`, without the safety hazards of
 * importing watch-mode.ts in-process (it spawns kubectl and can block
 * indefinitely once fully started).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');
const ENTRY = resolve(ROOT, 'src/watch-mode.ts');

function watchMode(...args: string[]) {
  const result = spawnSync(TSX, [ENTRY, ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  return result;
}

describe('heimdall watch CLI', () => {
  it('--help exits 0 and prints usage', () => {
    const { status, stdout } = watchMode('--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: heimdall --watch');
    expect(stdout).toContain('--model <provider/model>');
  });

  it('-h is an alias for --help', () => {
    const { status, stdout } = watchMode('-h');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: heimdall --watch');
  });

  it('exits 1 on an unknown option', () => {
    const { status, stderr } = watchMode('--bogus');
    expect(status).toBe(1);
    expect(stderr).toContain('unknown option: --bogus');
  });

  it('exits 1 when --model is missing its value', () => {
    const { status, stderr } = watchMode('--model');
    expect(status).toBe(1);
    expect(stderr).toContain('--model requires a value');
  });
});
