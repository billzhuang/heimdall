/**
 * Characterization tests for the format-json.ts entry point.
 *
 * format-json.ts wires stdin -> parseOneShotOutput -> stdout, then optionally
 * fires a Slack notification and a task-history append. It has no
 * `isMainModule` guard, so it runs as a real subprocess here (spawning it
 * would attach live stdin listeners if imported directly in-process).
 *
 * cwd is a fresh temp dir with no heimdall.config.yaml, so loadConfig()
 * always falls back to defaultConfig() (slack disabled, no configured
 * task-history file) — deterministic, no real network or unexpected file I/O.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');
const SCRIPT = resolve(ROOT, 'src/format-json.ts');

let cwd: string;

beforeAll(() => {
  cwd = mkdtempSync(resolve(tmpdir(), 'heimdall-format-json-'));
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function runFormatJson(input: string, env: Record<string, string> = {}) {
  const { HEIMDALL_CONFIG: _1, HEIMDALL_CONFIG_YAML: _2, ...baseEnv } = process.env;
  const result = spawnSync(TSX, [SCRIPT], {
    cwd,
    input,
    encoding: 'utf-8',
    timeout: 10_000,
    env: { ...baseEnv, ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`format-json.ts exited with status ${result.status}. Stderr: ${result.stderr}`);
  }
  return result;
}

describe('format-json.ts (characterization)', () => {
  it('parses stdin and writes a single JSON line to stdout', () => {
    const raw = 'Thinking Summary:\n- checked pods\n\nAnswer:\nEverything is fine.\n';
    const { status, stdout } = runFormatJson(raw, { HEIMDALL_EVAL_MODE: '1' });

    expect(status).toBe(0);
    const lines = stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const finding = JSON.parse(lines[0]);
    expect(finding.summary).toBe('- checked pods');
    expect(finding.answer).toBe('Everything is fine.');
    expect(finding.severity).toBe('info');
  });

  it('defaults the model to anthropic/claude-sonnet-4-6 when HEIMDALL_MODEL is unset', () => {
    const { stdout } = runFormatJson('Thinking Summary:\n- x\n\nAnswer:\ny\n', {
      HEIMDALL_EVAL_MODE: '1',
    });
    const finding = JSON.parse(stdout.trim());
    expect(finding.model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('honors HEIMDALL_MODEL for the embedded model field', () => {
    const { stdout } = runFormatJson('Thinking Summary:\n- x\n\nAnswer:\ny\n', {
      HEIMDALL_EVAL_MODE: '1',
      HEIMDALL_MODEL: 'anthropic/claude-opus-4-8',
    });
    const finding = JSON.parse(stdout.trim());
    expect(finding.model).toBe('anthropic/claude-opus-4-8');
  });

  it('exits cleanly without HEIMDALL_EVAL_MODE when slack/learning are unconfigured and no prompt is set', () => {
    const { status, stdout } = runFormatJson('Thinking Summary:\n- x\n\nAnswer:\ny\n');
    expect(status).toBe(0);
    const finding = JSON.parse(stdout.trim());
    expect(finding.answer).toBe('y');
  });

  it('exits cleanly when a prompt is set but HEIMDALL_NO_LEARN=1 skips history logging', () => {
    const { status, stdout } = runFormatJson('Thinking Summary:\n- x\n\nAnswer:\ny\n', {
      HEIMDALL_PROMPT: 'why is my pod crashing',
      HEIMDALL_NO_LEARN: '1',
    });
    expect(status).toBe(0);
    const finding = JSON.parse(stdout.trim());
    expect(finding.answer).toBe('y');
  });

  it('emits valid JSON even for raw output with no recognizable sections', () => {
    const { status, stdout } = runFormatJson('just some plain text\n', { HEIMDALL_EVAL_MODE: '1' });
    expect(status).toBe(0);
    const finding = JSON.parse(stdout.trim());
    expect(finding.answer).toBe('just some plain text');
  });
});
