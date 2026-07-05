import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSelfImproveArgs, main } from '../../self-improve-mode.ts';
import { loadScenarios, runScenario } from '../eval-runner.ts';
import { appendLearningEntry, readLearningLog } from '../self-improve.ts';
import { readTaskHistory } from '../task-history.ts';
import { loadConfig } from '../config.ts';
import { resolveBinPath } from '../bin-path.ts';

vi.mock('../eval-runner.ts');
vi.mock('../bin-path.ts');
vi.mock('../config.ts');
vi.mock('../self-improve.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../self-improve.ts')>();
  return { ...actual, appendLearningEntry: vi.fn(), readLearningLog: vi.fn() };
});
vi.mock('../task-history.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../task-history.ts')>();
  return { ...actual, readTaskHistory: vi.fn() };
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');
const ENTRY = resolve(ROOT, 'src/self-improve-mode.ts');

function selfImproveMode(...args: string[]) {
  const result = spawnSync(TSX, [ENTRY, ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  return result;
}

describe('heimdall self-improve CLI', () => {
  it('--help exits 0 and prints usage', () => {
    const { status, stdout } = selfImproveMode('--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: heimdall self-improve');
    expect(stdout).toContain('--scenario, -s <name>');
    expect(stdout).toContain('--reflect');
  });

  it('-h is an alias for --help', () => {
    const { status, stdout } = selfImproveMode('-h');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: heimdall self-improve');
  });

  it('exits 1 when --from-log is passed without --reflect', () => {
    const { status, stderr } = selfImproveMode('--from-log');
    expect(status).toBe(1);
    expect(stderr).toContain('--from-log requires --reflect');
  });
});

describe('parseSelfImproveArgs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns defaults for empty args', () => {
    expect(parseSelfImproveArgs([])).toEqual({
      scenarioFilter: undefined,
      reflect: false,
      fromLog: false,
      cliLogPath: undefined,
      logStdout: false,
    });
  });

  it('parses --scenario/-s and --scenario=<value>', () => {
    expect(parseSelfImproveArgs(['--scenario', 'crashloop'])).toMatchObject({ scenarioFilter: 'crashloop' });
    expect(parseSelfImproveArgs(['-s', 'oom'])).toMatchObject({ scenarioFilter: 'oom' });
    expect(parseSelfImproveArgs(['--scenario=crashloop'])).toMatchObject({ scenarioFilter: 'crashloop' });
  });

  it('parses --reflect and --from-log', () => {
    expect(parseSelfImproveArgs(['--reflect'])).toMatchObject({ reflect: true });
    expect(parseSelfImproveArgs(['--from-log'])).toMatchObject({ fromLog: true });
    expect(parseSelfImproveArgs(['--reflect', '--from-log'])).toMatchObject({ reflect: true, fromLog: true });
  });

  it('parses --log-path/-l and --log-path=<value>', () => {
    expect(parseSelfImproveArgs(['--log-path', '/tmp/log.jsonl'])).toMatchObject({ cliLogPath: '/tmp/log.jsonl' });
    expect(parseSelfImproveArgs(['-l', '/tmp/log.jsonl'])).toMatchObject({ cliLogPath: '/tmp/log.jsonl' });
    expect(parseSelfImproveArgs(['--log-path=/tmp/log.jsonl'])).toMatchObject({ cliLogPath: '/tmp/log.jsonl' });
  });

  it('parses --log-stdout', () => {
    expect(parseSelfImproveArgs(['--log-stdout'])).toMatchObject({ logStdout: true });
  });

  it('silently ignores unrecognized flags', () => {
    expect(parseSelfImproveArgs(['--no-such-flag'])).toEqual({
      scenarioFilter: undefined,
      reflect: false,
      fromLog: false,
      cliLogPath: undefined,
      logStdout: false,
    });
  });

  it('parses a combination of flags', () => {
    expect(
      parseSelfImproveArgs(['--scenario', 'oom', '--reflect', '--log-stdout', '--log-path', '/tmp/x.jsonl']),
    ).toEqual({
      scenarioFilter: 'oom',
      reflect: true,
      fromLog: false,
      cliLogPath: '/tmp/x.jsonl',
      logStdout: true,
    });
  });

  it('prints usage and exits 0 for --help/-h', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    parseSelfImproveArgs(['--help']);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: heimdall self-improve'));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

const BASE_CONFIG = {
  learning: {
    enabled: true,
    file: undefined,
    logFile: undefined,
    baselineFile: undefined,
    rag: { enabled: false, topK: 5, minSimilarity: 0 },
  },
} as unknown as ReturnType<typeof loadConfig>;

describe('main()', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.mocked(loadConfig).mockReturnValue(BASE_CONFIG);
    vi.mocked(resolveBinPath).mockReturnValue('/fake/bin/heimdall');
    vi.mocked(readTaskHistory).mockResolvedValue([]);
    vi.mocked(readLearningLog).mockResolvedValue([]);
    vi.mocked(appendLearningEntry).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stdout(): string {
    return stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
  }

  it('reports all-passed when every scenario succeeds', async () => {
    vi.mocked(loadScenarios).mockResolvedValue([
      { path: '/scenarios/oom.yaml', scenario: { description: 'OOMKill', mocks: {}, prompt: 'diagnose oom' } },
    ]);
    vi.mocked(runScenario).mockResolvedValue({
      scenario: 'oom.yaml',
      prompt: 'diagnose oom',
      passed: true,
      failures: [],
    });

    await main([]);

    expect(stdout()).toContain('1 passed, 0 failed out of 1 scenarios');
    expect(stdout()).toContain('All scenarios passed');
    expect(appendLearningEntry).not.toHaveBeenCalled();
  });

  it('writes a learning entry per failing scenario and prints a tip without --reflect', async () => {
    vi.mocked(loadScenarios).mockResolvedValue([
      { path: '/scenarios/crashloop.yaml', scenario: { description: 'CrashLoop', mocks: {}, prompt: 'diagnose crash' } },
    ]);
    vi.mocked(runScenario).mockResolvedValue({
      scenario: 'crashloop.yaml',
      prompt: 'diagnose crash',
      passed: false,
      failures: ['missing expected keyword'],
    });

    await main([]);

    expect(stdout()).toContain('0 passed, 1 failed out of 1 scenarios');
    expect(appendLearningEntry).toHaveBeenCalledTimes(1);
    expect(stdout()).toContain('learning entry written to');
    expect(stdout()).toContain('run with --reflect');
  });

  it('emits learning entries as JSONL to stdout instead of writing when --log-stdout is set', async () => {
    vi.mocked(loadScenarios).mockResolvedValue([
      { path: '/scenarios/crashloop.yaml', scenario: { description: 'CrashLoop', mocks: {}, prompt: 'diagnose crash' } },
    ]);
    vi.mocked(runScenario).mockResolvedValue({
      scenario: 'crashloop.yaml',
      prompt: 'diagnose crash',
      passed: false,
      failures: ['missing expected keyword'],
    });

    await main(['--log-stdout']);

    expect(appendLearningEntry).not.toHaveBeenCalled();
    expect(stdout()).toContain('=== LEARNING ENTRIES (JSONL) ===');
    expect(stdout()).toContain('"scenario":"crashloop.yaml"');
  });

  it('prints a reflection prompt after failures when --reflect is set', async () => {
    vi.mocked(loadScenarios).mockResolvedValue([
      { path: '/scenarios/crashloop.yaml', scenario: { description: 'CrashLoop', mocks: {}, prompt: 'diagnose crash' } },
    ]);
    vi.mocked(runScenario).mockResolvedValue({
      scenario: 'crashloop.yaml',
      prompt: 'diagnose crash',
      passed: false,
      failures: ['missing expected keyword'],
    });

    await main(['--reflect']);

    expect(stdout()).toContain('Reflection prompt');
    expect(readTaskHistory).toHaveBeenCalled();
  });

  it('prints a reflection prompt when all pass but task history is non-empty', async () => {
    vi.mocked(loadScenarios).mockResolvedValue([
      { path: '/scenarios/oom.yaml', scenario: { description: 'OOMKill', mocks: {}, prompt: 'diagnose oom' } },
    ]);
    vi.mocked(runScenario).mockResolvedValue({
      scenario: 'oom.yaml',
      prompt: 'diagnose oom',
      passed: true,
      failures: [],
    });
    vi.mocked(readTaskHistory).mockResolvedValue([
      { id: '1', timestamp: 't', prompt: 'p', model: 'm', severity: 'info', summary: 's' },
    ]);

    await main(['--reflect']);

    expect(stdout()).toContain('Reflection prompt');
  });

  it('skips the reflection prompt when all pass and task history is empty', async () => {
    vi.mocked(loadScenarios).mockResolvedValue([
      { path: '/scenarios/oom.yaml', scenario: { description: 'OOMKill', mocks: {}, prompt: 'diagnose oom' } },
    ]);
    vi.mocked(runScenario).mockResolvedValue({
      scenario: 'oom.yaml',
      prompt: 'diagnose oom',
      passed: true,
      failures: [],
    });

    await main(['--reflect']);

    expect(stdout()).not.toContain('Reflection prompt');
  });

  it('reflects on the existing log with --from-log --reflect without running scenarios', async () => {
    vi.mocked(readLearningLog).mockResolvedValue([
      { id: '1', timestamp: 't', scenario: 'oom.yaml', prompt: 'p', failures: ['x'], suggestion: 'sugg' },
    ]);

    await main(['--from-log', '--reflect']);

    expect(loadScenarios).not.toHaveBeenCalled();
    expect(stdout()).toContain('Reflecting on 1 eval entry and 0 task history entries');
  });

  it('reports no entries found for --from-log --reflect when both logs are empty', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    await main(['--from-log', '--reflect']);

    expect(stdout()).toContain('No entries found in');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 1 when --from-log is passed without --reflect', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    await expect(main(['--from-log'])).rejects.toThrow('exit');

    expect(stderrSpy).toHaveBeenCalledWith('--from-log requires --reflect\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints an error and exits 1 when loadScenarios throws', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    vi.mocked(loadScenarios).mockRejectedValue(new Error('boom'));

    await expect(main([])).rejects.toThrow('exit');

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Error loading scenarios: boom'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints an error and exits 1 when no scenario files are found', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    vi.mocked(loadScenarios).mockResolvedValue([]);

    await expect(main([])).rejects.toThrow('exit');

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('No scenario files found in'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
