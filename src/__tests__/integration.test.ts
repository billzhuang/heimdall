/**
 * CLI integration smoke tests — verify the `heimdall` binary starts, parses
 * flags correctly, and exits with the right code without requiring an LLM token
 * or a live cluster.  These tests catch broken shell scripts, missing
 * node_modules, and flag-parsing regressions.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = resolve(ROOT, 'bin/heimdall');

function heimdall(...args: string[]) {
  const result = spawnSync(BIN, args, {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  return result;
}

describe('heimdall binary smoke tests', () => {
  it('--help exits 0 and shows usage', () => {
    const { status, stdout } = heimdall('--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('-p, --prompt');
    expect(stdout).toContain('--watch');
    expect(stdout).toContain('triage');
  });

  it('-h is an alias for --help', () => {
    const { status, stdout } = heimdall('-h');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage:');
  });

  it('exits 1 when called with no arguments', () => {
    const { status, stderr } = heimdall();
    expect(status).toBe(1);
    expect(stderr).toMatch(/Error:/);
  });

  it('exits 1 for an unrecognised flag', () => {
    const { status, stderr } = heimdall('--no-such-flag');
    expect(status).toBe(1);
    expect(stderr).toContain('unknown option');
  });

  it('exits 1 for an unexpected positional argument', () => {
    const { status, stderr } = heimdall('unknownsubcmd');
    expect(status).toBe(1);
    expect(stderr).toContain('unexpected argument');
  });

  it('exits 1 when --json and --watch are combined', () => {
    const { status, stderr } = heimdall('--json', '--watch');
    expect(status).toBe(1);
    expect(stderr).toContain('not compatible');
  });

  it('exits 1 when -p is missing its argument', () => {
    const { status, stderr } = heimdall('-p');
    expect(status).toBe(1);
    expect(stderr).toMatch(/Error:/);
  });

  it('exits 1 for --format with an unknown value', () => {
    const { status, stderr } = heimdall('--format', 'csv');
    expect(status).toBe(1);
    expect(stderr).toContain('unknown format');
  });
});

// ---------------------------------------------------------------------------
// --model flag validation
// ---------------------------------------------------------------------------

describe('heimdall --model flag validation', () => {
  it('exits 1 when --model value has no provider/ prefix', () => {
    const { status, stderr } = heimdall('--model', 'claude-opus-4-8', '-p', 'test');
    expect(status).toBe(1);
    expect(stderr).toContain('provider/model');
  });

  it('exits 1 for --model= with no provider/ prefix', () => {
    const { status, stderr } = heimdall('--model=claude-opus-4-8', '-p', 'test');
    expect(status).toBe(1);
    expect(stderr).toContain('provider/model');
  });

  it('exits 1 for --model= with an empty value', () => {
    const { status, stderr } = heimdall('--model=', '-p', 'test');
    expect(status).toBe(1);
    expect(stderr).toMatch(/Error:/);
  });

  it('exits 1 when --model has no argument', () => {
    const { status, stderr } = heimdall('-p', 'test', '--model');
    expect(status).toBe(1);
    expect(stderr).toMatch(/Error:/);
  });
});

// ---------------------------------------------------------------------------
// --backend flag validation
// ---------------------------------------------------------------------------

describe('heimdall --backend flag validation', () => {
  it('exits 1 for an unknown backend', () => {
    const { status, stderr } = heimdall('--backend', 'llama', '-p', 'test');
    expect(status).toBe(1);
    expect(stderr).toContain('unknown backend');
  });

  it('exits 1 when --backend has no argument', () => {
    const { status, stderr } = heimdall('-p', 'test', '--backend');
    expect(status).toBe(1);
    expect(stderr).toMatch(/Error:/);
  });

  it('exits 1 for --backend claude-cli combined with --watch', () => {
    const { status, stderr } = heimdall('--backend', 'claude-cli', '--watch');
    expect(status).toBe(1);
    expect(stderr).toContain('not compatible');
  });

  it('exits 1 for --backend codex-cli combined with --watch', () => {
    const { status, stderr } = heimdall('--backend', 'codex-cli', '--watch');
    expect(status).toBe(1);
    expect(stderr).toContain('not compatible');
  });

  it('exits 1 for --backend claude-cli combined with triage', () => {
    const { status, stderr } = heimdall('--backend', 'claude-cli', 'triage');
    expect(status).toBe(1);
    expect(stderr).toContain('not compatible');
  });

  it('exits 1 for --backend codex-cli combined with triage', () => {
    const { status, stderr } = heimdall('--backend', 'codex-cli', 'triage');
    expect(status).toBe(1);
    expect(stderr).toContain('not compatible');
  });
});

// ---------------------------------------------------------------------------
// --json incompatibility checks
// ---------------------------------------------------------------------------

describe('heimdall --json incompatibility checks', () => {
  it('exits 1 when --json and triage are combined', () => {
    const { status, stderr } = heimdall('--json', 'triage');
    expect(status).toBe(1);
    expect(stderr).toContain('not compatible');
  });

  it('exits 1 when --json and schedule are combined', () => {
    const { status, stderr } = heimdall('--json', 'schedule');
    expect(status).toBe(1);
    expect(stderr).toContain('not compatible');
  });

  it('exits 1 when --json and self-improve are combined', () => {
    const { status, stderr } = heimdall('--json', 'self-improve');
    expect(status).toBe(1);
    expect(stderr).toContain('not compatible');
  });

  it('exits 1 when --json and self-loop are combined', () => {
    const { status, stderr } = heimdall('--json', 'self-loop');
    expect(status).toBe(1);
    expect(stderr).toContain('not compatible');
  });
});

// ---------------------------------------------------------------------------
// --format flag edge cases
// ---------------------------------------------------------------------------

describe('heimdall --format flag edge cases', () => {
  it('exits 1 when --format has no argument', () => {
    const { status, stderr } = heimdall('-p', 'test', '--format');
    expect(status).toBe(1);
    expect(stderr).toMatch(/Error:/);
  });
});
