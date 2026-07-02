import { describe, it, expect, vi, afterEach } from 'vitest';
import { requirePositiveInt, parseSelfLoopArgs, printSelfLoopSummary } from '../../self-loop-mode.ts';
import type { IterationResult } from '../self-loop.ts';

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

describe('parseSelfLoopArgs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns defaults when given no args', () => {
    expect(parseSelfLoopArgs([])).toEqual({
      maxIterations: 3,
      dryRun: false,
      backend: 'claude-cli',
      scenarioFilter: undefined,
      cliLogPath: undefined,
      reflectionTimeoutMs: 180_000,
    });
  });

  it('parses --max-iterations in space, equals, and short-flag forms', () => {
    expect(parseSelfLoopArgs(['--max-iterations', '5']).maxIterations).toBe(5);
    expect(parseSelfLoopArgs(['--max-iterations=7']).maxIterations).toBe(7);
    expect(parseSelfLoopArgs(['-n', '2']).maxIterations).toBe(2);
  });

  it('parses --dry-run', () => {
    expect(parseSelfLoopArgs(['--dry-run']).dryRun).toBe(true);
  });

  it('parses --backend in space, equals, and short-flag forms', () => {
    expect(parseSelfLoopArgs(['--backend', 'codex-cli']).backend).toBe('codex-cli');
    expect(parseSelfLoopArgs(['--backend=codex-cli']).backend).toBe('codex-cli');
    expect(parseSelfLoopArgs(['-b', 'codex-cli']).backend).toBe('codex-cli');
  });

  it('parses --scenario in space, equals, and short-flag forms', () => {
    expect(parseSelfLoopArgs(['--scenario', 'foo']).scenarioFilter).toBe('foo');
    expect(parseSelfLoopArgs(['--scenario=foo']).scenarioFilter).toBe('foo');
    expect(parseSelfLoopArgs(['-s', 'foo']).scenarioFilter).toBe('foo');
  });

  it('parses --log-path in space and short-flag forms', () => {
    expect(parseSelfLoopArgs(['--log-path', '/tmp/log.jsonl']).cliLogPath).toBe('/tmp/log.jsonl');
    expect(parseSelfLoopArgs(['-l', '/tmp/log.jsonl']).cliLogPath).toBe('/tmp/log.jsonl');
  });

  it('parses --timeout in seconds and converts to milliseconds', () => {
    expect(parseSelfLoopArgs(['--timeout', '30']).reflectionTimeoutMs).toBe(30_000);
    expect(parseSelfLoopArgs(['--timeout=45']).reflectionTimeoutMs).toBe(45_000);
  });

  it('prints help and exits 0 for -h/--help', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    parseSelfLoopArgs(['--help']);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: heimdall self-loop [options]'));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('writes an error and exits 1 for an unknown option', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    parseSelfLoopArgs(['--bogus']);
    expect(stderrSpy).toHaveBeenCalledWith("Error: unknown option '--bogus'\nRun with --help for usage.\n");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes an error and exits 1 for an unknown backend', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    parseSelfLoopArgs(['--backend', 'bogus-cli']);
    expect(stderrSpy).toHaveBeenCalledWith(
      "Error: unknown backend 'bogus-cli'; supported: claude-cli, codex-cli\n",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 via requirePositiveInt for a non-positive --max-iterations', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    parseSelfLoopArgs(['--max-iterations', '0']);
    expect(stderrSpy).toHaveBeenCalledWith('Error: --max-iterations must be a positive integer\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('printSelfLoopSummary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports no iterations when history is empty', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    printSelfLoopSummary([], 1, '/tmp/learning-log.jsonl', { dryRun: false });
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('No iterations were run (all scenarios already passing or LLM unavailable).');
    expect(output).not.toContain('Final score');
  });

  it('reports dry run complete when history is empty and dryRun is true', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    printSelfLoopSummary([], 1, '/tmp/learning-log.jsonl', { dryRun: true });
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('Dry run complete. No changes were applied.');
    expect(output).not.toContain('No iterations were run');
    expect(output).not.toContain('Final score');
  });

  it('reports a KEPT iteration with the final score and instructions.ts note', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const history: IterationResult[] = [
      { iteration: 1, baselineScore: 0.5, newScore: 0.75, proposalCount: 2, appliedCount: 2, improved: true, reverted: false },
    ];
    printSelfLoopSummary(history, 0.75, '/tmp/learning-log.jsonl', { dryRun: false });
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('Iteration 1: 50% → 75% (+25pp) | 2 patches | KEPT');
    expect(output).toContain('Final score: 75%');
    expect(output).toContain('instructions.ts was updated. Review changes with: git diff src/lib/instructions.ts');
    expect(output).toContain('Learning entries saved to: /tmp/learning-log.jsonl');
  });

  it('reports a REVERTED iteration without the instructions.ts note', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const history: IterationResult[] = [
      { iteration: 1, baselineScore: 0.5, newScore: 0.5, proposalCount: 1, appliedCount: 1, improved: false, reverted: true },
    ];
    printSelfLoopSummary(history, 0.5, '/tmp/learning-log.jsonl', { dryRun: false });
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('Iteration 1: 50% → 50% (+0pp) | 1 patch | REVERTED');
    expect(output).not.toContain('instructions.ts was updated');
  });

  it('reports a NO_CHANGE iteration when no patches were proposed', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const history: IterationResult[] = [
      { iteration: 1, baselineScore: 0.5, newScore: 0.5, proposalCount: 0, appliedCount: 0, improved: false, reverted: false },
    ];
    printSelfLoopSummary(history, 0.5, '/tmp/learning-log.jsonl', { dryRun: false });
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('Iteration 1: 50% → 50% (+0pp) | 0 patches | NO_CHANGE');
  });
});
