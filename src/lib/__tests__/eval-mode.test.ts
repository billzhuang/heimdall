/**
 * Characterization tests for `heimdall eval` CLI argument handling.
 *
 * eval-mode.ts previously ran `main()` unconditionally at import time (no
 * `import.meta.url === process.argv[1]` guard used by the other `*-mode.ts`
 * entry points), so its argument parsing could only be exercised end-to-end
 * via a subprocess. These spawnSync-based tests pin that observable CLI
 * behavior; `parseEvalArgs` below is exercised directly once extracted.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEvalArgs } from '../../eval-mode.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');
const ENTRY = resolve(ROOT, 'src/eval-mode.ts');

function evalMode(...args: string[]) {
  const result = spawnSync(TSX, [ENTRY, ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  return result;
}

describe('heimdall eval CLI', () => {
  it('--help exits 0 and prints usage', () => {
    const { status, stdout } = evalMode('--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: heimdall eval');
    expect(stdout).toContain('--scenario, -s <name>');
    expect(stdout).toContain('--model <provider/model>');
  });

  it('-h is an alias for --help', () => {
    const { status, stdout } = evalMode('-h');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: heimdall eval');
  });

  it('reports no matching scenarios and exits 1', () => {
    const { status, stderr } = evalMode('--scenario', '__nonexistent__');
    expect(status).toBe(1);
    expect(stderr).toContain('No scenario files matching "__nonexistent__" found');
  });

  it('accepts --scenario=<name> form', () => {
    const { status, stderr } = evalMode('--scenario=__nonexistent__');
    expect(status).toBe(1);
    expect(stderr).toContain('No scenario files matching "__nonexistent__" found');
  });

  it('exits 1 when -m is given without a value', () => {
    const { status, stderr } = evalMode('-m');
    expect(status).toBe(1);
    expect(stderr).toContain('-m requires a value');
  });

  it('silently ignores unrecognized flags and continues parsing', () => {
    const { status, stderr } = evalMode('--no-such-flag', '--scenario', '__nonexistent__');
    expect(status).toBe(1);
    expect(stderr).toContain('No scenario files matching "__nonexistent__" found');
  });
});

describe('parseEvalArgs', () => {
  it('returns no filter/model/help for empty args', () => {
    expect(parseEvalArgs([])).toEqual({ scenarioFilter: undefined, modelFlag: undefined, help: false });
  });

  it('parses --scenario <name>', () => {
    expect(parseEvalArgs(['--scenario', 'crashloop'])).toMatchObject({ scenarioFilter: 'crashloop', help: false });
  });

  it('parses -s <name>', () => {
    expect(parseEvalArgs(['-s', 'oom'])).toMatchObject({ scenarioFilter: 'oom', help: false });
  });

  it('parses --scenario=<name>', () => {
    expect(parseEvalArgs(['--scenario=crashloop'])).toMatchObject({ scenarioFilter: 'crashloop', help: false });
  });

  it('parses --model <value>', () => {
    expect(parseEvalArgs(['--model', 'anthropic/claude-sonnet-4-6'])).toMatchObject({
      modelFlag: 'anthropic/claude-sonnet-4-6',
      help: false,
    });
  });

  it('parses -m <value> and --model=<value>', () => {
    expect(parseEvalArgs(['-m', 'foo/bar'])).toMatchObject({ modelFlag: 'foo/bar', help: false });
    expect(parseEvalArgs(['--model=foo/bar'])).toMatchObject({ modelFlag: 'foo/bar', help: false });
  });

  it('parses combined --scenario and --model flags', () => {
    expect(parseEvalArgs(['--scenario', 'crashloop', '--model', 'foo/bar'])).toMatchObject({
      scenarioFilter: 'crashloop',
      modelFlag: 'foo/bar',
      help: false,
    });
  });

  it('returns help:true for -h or --help and stops parsing further flags', () => {
    expect(parseEvalArgs(['-h'])).toMatchObject({ help: true });
    expect(parseEvalArgs(['--help'])).toMatchObject({ help: true });
    expect(parseEvalArgs(['--help', '--scenario', 'crashloop'])).toEqual({
      scenarioFilter: undefined,
      modelFlag: undefined,
      help: true,
    });
  });

  it('ignores an unrecognized flag and keeps parsing', () => {
    expect(parseEvalArgs(['--no-such-flag', '--scenario', 'crashloop'])).toMatchObject({
      scenarioFilter: 'crashloop',
      help: false,
    });
  });

  it('ignores a trailing --scenario/-s with no value', () => {
    expect(parseEvalArgs(['--scenario'])).toMatchObject({ scenarioFilter: undefined, help: false });
  });
});
