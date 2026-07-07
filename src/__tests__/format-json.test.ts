/**
 * Tests for the format-json.ts entry point.
 *
 * format-json.ts wires stdin -> parseOneShotOutput -> stdout, then optionally
 * fires a Slack notification and a task-history append, guarded behind an
 * `isMainModule` check. The subprocess suite below still exercises it as a
 * real subprocess to cover the actual CLI entry point end-to-end (stdin
 * wiring, stdout shape, exit code) — importing it in-process would skip the
 * guard's stdin listeners entirely. The dispatch-logic suite below that
 * exercises `dispatchOneShotSideEffects` directly with mocked dependencies.
 *
 * cwd is a fresh temp dir with no heimdall.config.yaml, so loadConfig()
 * always falls back to defaultConfig() (slack disabled, no configured
 * task-history file) — deterministic, no real network or unexpected file I/O.
 *
 * The subprocess env is stripped of every ambient HEIMDALL_ or SLACK_ var so
 * an operator's or CI's own environment can never leak into the child and
 * change test behavior (e.g. a stray HEIMDALL_PROMPT would otherwise make
 * the "no side effects" case append to the real repo's task-history file,
 * since its default path is resolved from the script's own directory, not cwd).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dispatchOneShotSideEffects, type OneShotSideEffectDeps } from '../format-json.ts';
import type { OneShotFinding } from '../lib/format-output.ts';
import type { HeimdallConfig } from '../lib/config.ts';

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
  const sanitizedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(?:HEIMDALL_|SLACK_)/.test(key)),
  );
  const result = spawnSync(TSX, [SCRIPT], {
    cwd,
    input,
    encoding: 'utf-8',
    timeout: 10_000,
    env: { ...sanitizedEnv, ...env },
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

describe('dispatchOneShotSideEffects', () => {
  const FINDING: OneShotFinding = {
    summary: '- checked pods',
    answer: 'Everything is fine.',
    severity: 'critical',
    suggestedCommands: [],
  };

  function makeDeps(): OneShotSideEffectDeps {
    return {
      sendSlack: vi.fn().mockResolvedValue(undefined),
      appendHistory: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('does nothing when HEIMDALL_EVAL_MODE=1, even if slack/learning are configured', () => {
    const deps = makeDeps();
    const config = { slack: { enabled: true, webhookUrl: 'https://hooks.example/x' } } as HeimdallConfig;

    dispatchOneShotSideEffects(FINDING, 'anthropic/claude-sonnet-4-6', config, { HEIMDALL_EVAL_MODE: '1', HEIMDALL_PROMPT: 'why' }, '/scenarios', deps);

    expect(deps.sendSlack).not.toHaveBeenCalled();
    expect(deps.appendHistory).not.toHaveBeenCalled();
  });

  it('sends a Slack notification when slack.enabled and a webhook URL is configured', () => {
    const deps = makeDeps();
    const config = {
      slack: { enabled: true, webhookUrl: 'https://hooks.example/x', channel: '#sre', minSeverity: 'warning', timeoutMs: 5000 },
    } as HeimdallConfig;

    dispatchOneShotSideEffects(FINDING, 'anthropic/claude-sonnet-4-6', config, {}, '/scenarios', deps);

    expect(deps.sendSlack).toHaveBeenCalledTimes(1);
    expect(deps.sendSlack).toHaveBeenCalledWith(FINDING, {
      webhookUrl: 'https://hooks.example/x',
      channel: '#sre',
      minSeverity: 'warning',
      timeoutMs: 5000,
    });
  });

  it('falls back to SLACK_WEBHOOK_URL when slack.webhookUrl is unset', () => {
    const deps = makeDeps();
    const config = { slack: { enabled: true } } as HeimdallConfig;

    dispatchOneShotSideEffects(FINDING, 'anthropic/claude-sonnet-4-6', config, { SLACK_WEBHOOK_URL: 'https://hooks.example/env' }, '/scenarios', deps);

    expect(deps.sendSlack).toHaveBeenCalledWith(FINDING, expect.objectContaining({ webhookUrl: 'https://hooks.example/env' }));
  });

  it('skips Slack when enabled but no webhook URL is available anywhere', () => {
    const deps = makeDeps();
    const config = { slack: { enabled: true } } as HeimdallConfig;

    dispatchOneShotSideEffects(FINDING, 'anthropic/claude-sonnet-4-6', config, {}, '/scenarios', deps);

    expect(deps.sendSlack).not.toHaveBeenCalled();
  });

  it('skips Slack when slack.enabled is false', () => {
    const deps = makeDeps();
    const config = { slack: { enabled: false, webhookUrl: 'https://hooks.example/x' } } as HeimdallConfig;

    dispatchOneShotSideEffects(FINDING, 'anthropic/claude-sonnet-4-6', config, {}, '/scenarios', deps);

    expect(deps.sendSlack).not.toHaveBeenCalled();
  });

  it('appends a task-history entry when learning is enabled and a prompt is set', () => {
    const deps = makeDeps();
    const config = {} as HeimdallConfig;

    dispatchOneShotSideEffects(FINDING, 'anthropic/claude-sonnet-4-6', config, { HEIMDALL_PROMPT: 'why is my pod crashing' }, '/scenarios', deps);

    expect(deps.appendHistory).toHaveBeenCalledTimes(1);
    const [entry, logPath] = (deps.appendHistory as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(entry).toMatchObject({
      prompt: 'why is my pod crashing',
      model: 'anthropic/claude-sonnet-4-6',
      severity: 'critical',
      summary: '- checked pods',
    });
    expect(logPath).toBe(resolve('/scenarios', 'task-history.jsonl'));
  });

  it('skips history logging when no prompt is set', () => {
    const deps = makeDeps();
    dispatchOneShotSideEffects(FINDING, 'anthropic/claude-sonnet-4-6', {} as HeimdallConfig, {}, '/scenarios', deps);
    expect(deps.appendHistory).not.toHaveBeenCalled();
  });

  it('skips history logging when HEIMDALL_NO_LEARN=1', () => {
    const deps = makeDeps();
    dispatchOneShotSideEffects(
      FINDING,
      'anthropic/claude-sonnet-4-6',
      {} as HeimdallConfig,
      { HEIMDALL_PROMPT: 'why', HEIMDALL_NO_LEARN: '1' },
      '/scenarios',
      deps,
    );
    expect(deps.appendHistory).not.toHaveBeenCalled();
  });

  it('skips history logging when learning.enabled is false', () => {
    const deps = makeDeps();
    const config = { learning: { enabled: false } } as HeimdallConfig;
    dispatchOneShotSideEffects(FINDING, 'anthropic/claude-sonnet-4-6', config, { HEIMDALL_PROMPT: 'why' }, '/scenarios', deps);
    expect(deps.appendHistory).not.toHaveBeenCalled();
  });
});
