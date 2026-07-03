import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requirePositiveInt, parseSelfLoopArgs } from '../../self-loop-mode.ts';

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
