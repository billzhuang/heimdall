import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  requirePositiveInt,
  parseSelfLoopArgs,
  runIteration,
  type IterationContext,
} from '../../self-loop-mode.ts';
import type { EvalResult } from '../eval-runner.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');
const ENTRY = resolve(ROOT, 'src/self-loop-mode.ts');

function selfLoopMode(...args: string[]) {
  const result = spawnSync(TSX, [ENTRY, ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  return result;
}

describe('heimdall self-loop CLI', () => {
  it('--help exits 0 and prints usage', () => {
    const { status, stdout } = selfLoopMode('--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: heimdall self-loop');
    expect(stdout).toContain('--max-iterations, -n <N>');
    expect(stdout).toContain('--backend, -b <name>');
  });

  it('-h is an alias for --help', () => {
    const { status, stdout } = selfLoopMode('-h');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: heimdall self-loop');
  });

  it('exits 1 on an unrecognized flag', () => {
    const { status, stderr } = selfLoopMode('--no-such-flag');
    expect(status).toBe(1);
    expect(stderr).toContain("Error: unknown option '--no-such-flag'");
  });

  it('exits 1 when --max-iterations has no value (falls through to unknown option)', () => {
    const { status, stderr } = selfLoopMode('--max-iterations');
    expect(status).toBe(1);
    expect(stderr).toContain("Error: unknown option '--max-iterations'");
  });

  it('exits 1 when --max-iterations is not a positive integer', () => {
    const { status, stderr } = selfLoopMode('--max-iterations', '0');
    expect(status).toBe(1);
    expect(stderr).toContain('Error: --max-iterations must be a positive integer');
  });

  it('accepts --max-iterations=<n> form and proceeds past arg parsing', () => {
    const { status, stderr } = selfLoopMode('--max-iterations=1', '--backend', 'bogus-backend');
    expect(status).toBe(1);
    expect(stderr).toContain("Error: unknown backend 'bogus-backend'; supported: claude-cli, codex-cli");
  });

  it('exits 1 when --timeout is not a positive integer', () => {
    const { status, stderr } = selfLoopMode('--timeout', 'abc');
    expect(status).toBe(1);
    expect(stderr).toContain('Error: --timeout must be a positive integer (seconds)');
  });

  it('exits 1 on an unknown --backend value after successful arg parsing', () => {
    const { status, stderr } = selfLoopMode('--backend', 'bogus-backend');
    expect(status).toBe(1);
    expect(stderr).toContain("Error: unknown backend 'bogus-backend'; supported: claude-cli, codex-cli");
  });
});

describe('parseSelfLoopArgs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns defaults for empty args', () => {
    expect(parseSelfLoopArgs([])).toEqual({
      maxIterations: 3,
      dryRun: false,
      backend: 'claude-cli',
      scenarioFilter: undefined,
      cliLogPath: undefined,
      reflectionTimeoutMs: 180_000,
    });
  });

  it('parses --max-iterations <n> and -n <n>', () => {
    expect(parseSelfLoopArgs(['--max-iterations', '5'])).toMatchObject({ maxIterations: 5 });
    expect(parseSelfLoopArgs(['-n', '2'])).toMatchObject({ maxIterations: 2 });
    expect(parseSelfLoopArgs(['--max-iterations=7'])).toMatchObject({ maxIterations: 7 });
  });

  it('parses --dry-run', () => {
    expect(parseSelfLoopArgs(['--dry-run'])).toMatchObject({ dryRun: true });
  });

  it('parses --backend/-b and --backend=<value>', () => {
    expect(parseSelfLoopArgs(['--backend', 'codex-cli'])).toMatchObject({ backend: 'codex-cli' });
    expect(parseSelfLoopArgs(['-b', 'codex-cli'])).toMatchObject({ backend: 'codex-cli' });
    expect(parseSelfLoopArgs(['--backend=codex-cli'])).toMatchObject({ backend: 'codex-cli' });
  });

  it('parses --scenario/-s and --scenario=<value>', () => {
    expect(parseSelfLoopArgs(['--scenario', 'crashloop'])).toMatchObject({ scenarioFilter: 'crashloop' });
    expect(parseSelfLoopArgs(['-s', 'oom'])).toMatchObject({ scenarioFilter: 'oom' });
    expect(parseSelfLoopArgs(['--scenario=crashloop'])).toMatchObject({ scenarioFilter: 'crashloop' });
  });

  it('parses --log-path/-l', () => {
    expect(parseSelfLoopArgs(['--log-path', '/tmp/log.jsonl'])).toMatchObject({ cliLogPath: '/tmp/log.jsonl' });
    expect(parseSelfLoopArgs(['-l', '/tmp/log.jsonl'])).toMatchObject({ cliLogPath: '/tmp/log.jsonl' });
  });

  it('parses --timeout <seconds> and --timeout=<seconds> into milliseconds', () => {
    expect(parseSelfLoopArgs(['--timeout', '30'])).toMatchObject({ reflectionTimeoutMs: 30_000 });
    expect(parseSelfLoopArgs(['--timeout=45'])).toMatchObject({ reflectionTimeoutMs: 45_000 });
  });

  it('parses a combination of flags', () => {
    expect(parseSelfLoopArgs(['--max-iterations', '2', '--dry-run', '--backend', 'codex-cli', '--scenario', 'oom'])).toEqual({
      maxIterations: 2,
      dryRun: true,
      backend: 'codex-cli',
      scenarioFilter: 'oom',
      cliLogPath: undefined,
      reflectionTimeoutMs: 180_000,
    });
  });

  it('exits 1 and writes an error for an unrecognized flag', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    parseSelfLoopArgs(['--bogus']);
    expect(stderrSpy).toHaveBeenCalledWith("Error: unknown option '--bogus'\nRun with --help for usage.\n");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints usage and exits 0 for --help/-h', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    parseSelfLoopArgs(['--help']);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: heimdall self-loop'));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe('requirePositiveInt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns without error for a valid positive integer', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    requirePositiveInt(1, 'flag must be a positive integer');
    requirePositiveInt(5, 'flag must be a positive integer');
    requirePositiveInt(100, 'flag must be a positive integer');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('writes the error message and exits for NaN', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    requirePositiveInt(NaN, 'flag must be a positive integer');
    expect(stderrSpy).toHaveBeenCalledWith('Error: flag must be a positive integer\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes the error message and exits for zero', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    requirePositiveInt(0, 'flag must be a positive integer');
    expect(stderrSpy).toHaveBeenCalledWith('Error: flag must be a positive integer\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes the error message and exits for a negative integer', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    requirePositiveInt(-3, 'flag must be a positive integer');
    expect(stderrSpy).toHaveBeenCalledWith('Error: flag must be a positive integer\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('includes the "(seconds)" suffix in the error message when provided', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    requirePositiveInt(NaN, '--timeout must be a positive integer (seconds)');
    expect(stderrSpy).toHaveBeenCalledWith('Error: --timeout must be a positive integer (seconds)\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('runIteration', () => {
  const INITIAL_CONTENT = 'BEFORE_TEXT marker line\nsecond line\n';
  const PATCHED_CONTENT = 'AFTER_TEXT marker line\nsecond line\n';

  const PATCH_RESPONSE = [
    '## Change 1',
    'FIND:',
    '```',
    'BEFORE_TEXT marker line',
    '```',
    'REPLACE:',
    '```',
    'AFTER_TEXT marker line',
    '```',
  ].join('\n');

  const NON_MATCHING_PATCH_RESPONSE = [
    '## Change 1',
    'FIND:',
    '```',
    'TEXT NOT IN FILE',
    '```',
    'REPLACE:',
    '```',
    'X',
    '```',
  ].join('\n');

  const PASSING_RESULT: EvalResult = { scenario: 's1', prompt: 'p1', passed: true, failures: [] };
  const FAILING_RESULT: EvalResult = { scenario: 's1', prompt: 'p1', passed: false, failures: ['boom'] };

  let tmpDir: string;
  let instructionsPath: string;
  let logPath: string;
  let taskHistoryPath: string;
  let proposalsDir: string;

  beforeEach(async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    tmpDir = await mkdtemp(join(tmpdir(), 'heimdall-self-loop-test-'));
    instructionsPath = join(tmpDir, 'instructions.ts');
    logPath = join(tmpDir, 'learning-log.jsonl');
    taskHistoryPath = join(tmpDir, 'task-history.jsonl');
    proposalsDir = join(tmpDir, 'proposals');
    await writeFile(instructionsPath, INITIAL_CONTENT, 'utf8');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function baseCtx(overrides: Partial<IterationContext> = {}): IterationContext {
    return {
      backend: 'claude-cli',
      reflectionTimeoutMs: 5_000,
      dryRun: false,
      logPath,
      taskHistoryPath,
      instructionsPath,
      proposalsDir,
      runAndPrint: vi.fn().mockResolvedValue([PASSING_RESULT]),
      callLlmFn: vi.fn().mockResolvedValue(PATCH_RESPONSE),
      ...overrides,
    };
  }

  it('stops with no pushResult when the LLM call fails', async () => {
    const ctx = baseCtx({ callLlmFn: vi.fn().mockRejectedValue(new Error('cli crashed')) });
    const outcome = await runIteration(1, [FAILING_RESULT], 0.5, ctx);
    expect(outcome).toEqual({ stop: true, currentResults: [FAILING_RESULT], currentScore: 0.5 });
    expect(await readFile(instructionsPath, 'utf8')).toBe(INITIAL_CONTENT);
  });

  it('stops with a zero-patch pushResult when the LLM proposes no changes', async () => {
    const ctx = baseCtx({ callLlmFn: vi.fn().mockResolvedValue('NO_CHANGES_NEEDED') });
    const outcome = await runIteration(2, [FAILING_RESULT], 0.5, ctx);
    expect(outcome.stop).toBe(true);
    expect(outcome.pushResult).toEqual({
      iteration: 2,
      baselineScore: 0.5,
      newScore: 0.5,
      proposalCount: 0,
      appliedCount: 0,
      improved: false,
      reverted: false,
    });
    expect(outcome.currentResults).toEqual([FAILING_RESULT]);
    expect(outcome.currentScore).toBe(0.5);
  });

  it('previews and stops without touching instructions.ts in dry-run mode', async () => {
    const ctx = baseCtx({ dryRun: true });
    const outcome = await runIteration(1, [FAILING_RESULT], 0.5, ctx);
    expect(outcome).toEqual({ stop: true, currentResults: [FAILING_RESULT], currentScore: 0.5 });
    expect(await readFile(instructionsPath, 'utf8')).toBe(INITIAL_CONTENT);
  });

  it('stops without a pushResult when no patch matches current content', async () => {
    const ctx = baseCtx({ callLlmFn: vi.fn().mockResolvedValue(NON_MATCHING_PATCH_RESPONSE) });
    const outcome = await runIteration(1, [FAILING_RESULT], 0.5, ctx);
    expect(outcome).toEqual({ stop: true, currentResults: [FAILING_RESULT], currentScore: 0.5 });
    expect(await readFile(instructionsPath, 'utf8')).toBe(INITIAL_CONTENT);
  });

  it('reverts instructions.ts and stops when re-running evals throws', async () => {
    const ctx = baseCtx({ runAndPrint: vi.fn().mockRejectedValue(new Error('eval crashed')) });
    const outcome = await runIteration(1, [FAILING_RESULT], 0.5, ctx);
    expect(outcome).toEqual({ stop: true, currentResults: [FAILING_RESULT], currentScore: 0.5 });
    expect(await readFile(instructionsPath, 'utf8')).toBe(INITIAL_CONTENT);
  });

  it('keeps patches and continues when the score improves but is not perfect', async () => {
    const newResults = [PASSING_RESULT, FAILING_RESULT];
    const ctx = baseCtx({ runAndPrint: vi.fn().mockResolvedValue(newResults) });
    const outcome = await runIteration(1, [FAILING_RESULT, FAILING_RESULT], 0, ctx);
    expect(outcome.stop).toBe(false);
    expect(outcome.pushResult).toEqual({
      iteration: 1,
      baselineScore: 0,
      newScore: 0.5,
      proposalCount: 1,
      appliedCount: 1,
      improved: true,
      reverted: false,
    });
    expect(outcome.currentResults).toBe(newResults);
    expect(outcome.currentScore).toBe(0.5);
    expect(await readFile(instructionsPath, 'utf8')).toBe(PATCHED_CONTENT);
  });

  it('keeps patches and stops when the score reaches 100%', async () => {
    const ctx = baseCtx({ runAndPrint: vi.fn().mockResolvedValue([PASSING_RESULT]) });
    const outcome = await runIteration(1, [FAILING_RESULT], 0, ctx);
    expect(outcome.stop).toBe(true);
    expect(outcome.pushResult?.improved).toBe(true);
    expect(outcome.currentScore).toBe(1);
    expect(await readFile(instructionsPath, 'utf8')).toBe(PATCHED_CONTENT);
  });

  it('reverts patches and stops when the score does not improve', async () => {
    const ctx = baseCtx({ runAndPrint: vi.fn().mockResolvedValue([FAILING_RESULT]) });
    const outcome = await runIteration(1, [FAILING_RESULT], 0, ctx);
    expect(outcome.stop).toBe(true);
    expect(outcome.pushResult).toEqual({
      iteration: 1,
      baselineScore: 0,
      newScore: 0,
      proposalCount: 1,
      appliedCount: 1,
      improved: false,
      reverted: true,
    });
    expect(outcome.currentResults).toEqual([FAILING_RESULT]);
    expect(outcome.currentScore).toBe(0);
    expect(await readFile(instructionsPath, 'utf8')).toBe(INITIAL_CONTENT);
  });

  it('persists a learning entry for each current failure before reflecting', async () => {
    const ctx = baseCtx({ dryRun: true });
    await runIteration(1, [FAILING_RESULT], 0.5, ctx);
    const log = await readFile(logPath, 'utf8');
    const lines = log.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ scenario: 's1', prompt: 'p1', failures: ['boom'] });
  });
});
