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

vi.mock('../config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.ts')>();
  return {
    ...actual,
    loadConfig: vi.fn(() => ({ learning: { rag: { enabled: false, topK: 0 } } }) as never),
  };
});

import { loadScenarios, runScenario } from '../eval-runner.ts';
import { main } from '../../self-improve-mode.ts';

describe('self-improve-mode main() — normal (non-reflect) flow', () => {
  let stdout: string[];
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    originalArgv = process.argv;
    // --log-stdout avoids writing the learning log to disk.
    process.argv = ['node', 'self-improve-mode.ts', '--log-stdout'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.argv = originalArgv;
  });

  it('prints Running/PASS/FAIL lines per scenario in order and a final summary', async () => {
    vi.mocked(loadScenarios).mockResolvedValue([
      { path: '/scenarios/a.yaml', scenario: { description: 'Scenario A' } as never },
      { path: '/scenarios/b.yaml', scenario: { description: 'Scenario B' } as never },
    ]);
    vi.mocked(runScenario)
      .mockResolvedValueOnce({ scenario: 'Scenario A', prompt: 'prompt-a', passed: true, failures: [] })
      .mockResolvedValueOnce({ scenario: 'Scenario B', prompt: 'prompt-b', passed: false, failures: ['missing X'] });

    await main();

    const out = stdout.join('');
    expect(out).toContain('  Running: Scenario A\n');
    expect(out).toContain('  ✓ PASS  Scenario A\n');
    expect(out).toContain('  Running: Scenario B\n');
    expect(out).toContain('  ✗ FAIL  Scenario B\n');
    expect(out).toContain('         - missing X\n');
    expect(out).toContain('Results: 1 passed, 1 failed out of 2 scenarios\n');
    expect(out.indexOf('Scenario A')).toBeLessThan(out.indexOf('Scenario B'));
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('reports no learning entries when all scenarios pass', async () => {
    vi.mocked(loadScenarios).mockResolvedValue([
      { path: '/scenarios/a.yaml', scenario: { description: 'Scenario A' } as never },
    ]);
    vi.mocked(runScenario).mockResolvedValueOnce({ scenario: 'Scenario A', prompt: 'prompt-a', passed: true, failures: [] });

    await main();

    const out = stdout.join('');
    expect(out).toContain('Results: 1 passed, 0 failed out of 1 scenarios\n');
    expect(out).toContain('All scenarios passed — no learning entries added.');
  });
});
