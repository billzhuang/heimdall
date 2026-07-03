import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../eval-runner.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../eval-runner.ts')>();
  const loadScenarios = vi.fn();
  const runScenario = vi.fn();
  // runAllScenarios normally calls the real runScenario via an internal same-module
  // binding that vi.mock cannot intercept, so re-implement its (trivial, already
  // separately-tested) loop here in terms of the mocked runScenario.
  const runAllScenarios = vi.fn(async (binPath: string, scenarios: Array<{ scenario: { description: string } }>, callbacks: { onBefore?: (name: string) => void; onResult?: (result: unknown) => void } = {}) => {
    const results = [];
    for (const { scenario } of scenarios) {
      callbacks.onBefore?.(scenario.description);
      const result = await runScenario(binPath, scenario);
      results.push(result);
      callbacks.onResult?.(result);
    }
    return results;
  });
  return { ...actual, loadScenarios, runScenario, runAllScenarios };
});

import { loadScenarios, runScenario } from '../eval-runner.ts';
import { main } from '../../eval-mode.ts';

describe('eval-mode main()', () => {
  let stdout: string[];
  let originalArgv: string[];
  let originalModel: string | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = [];
    originalModel = process.env.HEIMDALL_MODEL;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    originalArgv = process.argv;
    process.argv = ['node', 'eval-mode.ts'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.argv = originalArgv;
    if (originalModel === undefined) {
      delete process.env.HEIMDALL_MODEL;
    } else {
      process.env.HEIMDALL_MODEL = originalModel;
    }
  });

  it('prints Running/PASS/FAIL lines per scenario in order and a final summary', async () => {
    vi.mocked(loadScenarios).mockResolvedValue([
      { path: '/scenarios/a.yaml', scenario: { description: 'Scenario A' } as never },
      { path: '/scenarios/b.yaml', scenario: { description: 'Scenario B' } as never },
    ]);
    vi.mocked(runScenario)
      .mockResolvedValueOnce({ scenario: 'Scenario A', prompt: '', passed: true, failures: [] })
      .mockResolvedValueOnce({ scenario: 'Scenario B', prompt: '', passed: false, failures: ['missing X', 'missing Y'] });

    await main();

    const out = stdout.join('');
    expect(out).toContain('  Running: Scenario A\n');
    expect(out).toContain('  ✓ PASS  Scenario A\n');
    expect(out).toContain('  Running: Scenario B\n');
    expect(out).toContain('  ✗ FAIL  Scenario B\n');
    expect(out).toContain('         - missing X\n');
    expect(out).toContain('         - missing Y\n');
    expect(out).toContain('Results: 1 passed, 1 failed out of 2 scenarios\n');

    const orderedLines = [
      '  Running: Scenario A\n',
      '  ✓ PASS  Scenario A\n',
      '  Running: Scenario B\n',
      '  ✗ FAIL  Scenario B\n',
      '         - missing X\n',
      '         - missing Y\n',
      'Results: 1 passed, 1 failed out of 2 scenarios\n',
    ];
    let cursor = -1;
    for (const line of orderedLines) {
      const next = out.indexOf(line, cursor + 1);
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 0 (does not call process.exit) when all scenarios pass', async () => {
    vi.mocked(loadScenarios).mockResolvedValue([
      { path: '/scenarios/a.yaml', scenario: { description: 'Scenario A' } as never },
    ]);
    vi.mocked(runScenario).mockResolvedValueOnce({ scenario: 'Scenario A', prompt: '', passed: true, failures: [] });

    await main();

    expect(stdout.join('')).toContain('Results: 1 passed, 0 failed out of 1 scenarios\n');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
