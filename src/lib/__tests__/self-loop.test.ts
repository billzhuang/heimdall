import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: vi.fn(), writeFile: vi.fn() };
});

import { readFile, writeFile } from 'node:fs/promises';

beforeEach(() => {
  vi.resetAllMocks();
});

import {
  scoreResults,
  formatPct,
  buildStartupBanner,
  formatDryRunPreview,
  formatScoreChangeLine,
  buildSummaryReport,
  parseProposals,
  buildAutoReflectionPrompt,
  extractInstructionsSnippet,
  applyProposals,
  revertToSnapshot,
  snapshotInstructions,
  type IterationResult,
} from '../self-loop.ts';

describe('scoreResults', () => {
  it('returns 1.0 when all pass', () => {
    expect(scoreResults([{ passed: true }, { passed: true }])).toBe(1);
  });

  it('returns 0 when all fail', () => {
    expect(scoreResults([{ passed: false }, { passed: false }])).toBe(0);
  });

  it('returns 0.5 for half pass', () => {
    expect(scoreResults([{ passed: true }, { passed: false }])).toBe(0.5);
  });

  it('returns 1 for empty results', () => {
    expect(scoreResults([])).toBe(1);
  });
});

describe('parseProposals', () => {
  it('returns empty array for NO_CHANGES_NEEDED (exact match)', () => {
    expect(parseProposals('NO_CHANGES_NEEDED')).toEqual([]);
    expect(parseProposals('  NO_CHANGES_NEEDED  ')).toEqual([]);
  });

  it('does not short-circuit when NO_CHANGES_NEEDED is embedded in a longer response', () => {
    const output = `
## Change 1
FIND:
\`\`\`
old text
\`\`\`
REPLACE:
\`\`\`
NO_CHANGES_NEEDED for this section but new text
\`\`\`
`;
    const patches = parseProposals(output);
    expect(patches).toHaveLength(1);
  });

  it('parses a single FIND/REPLACE block', () => {
    const output = `
## Change 1
FIND:
\`\`\`
old text here
\`\`\`
REPLACE:
\`\`\`
new text here
\`\`\`
`;
    const patches = parseProposals(output);
    expect(patches).toHaveLength(1);
    expect(patches[0].find).toBe('old text here\n');
    expect(patches[0].replace).toBe('new text here\n');
  });

  it('parses multiple FIND/REPLACE blocks', () => {
    const output = `
## Change 1
FIND:
\`\`\`
first find
\`\`\`
REPLACE:
\`\`\`
first replace
\`\`\`

## Change 2
FIND:
\`\`\`
second find
\`\`\`
REPLACE:
\`\`\`
second replace
\`\`\`
`;
    const patches = parseProposals(output);
    expect(patches).toHaveLength(2);
    expect(patches[0].find).toBe('first find\n');
    expect(patches[1].find).toBe('second find\n');
  });

  it('skips blocks with empty FIND', () => {
    const output = `
## Change 1
FIND:
\`\`\`

\`\`\`
REPLACE:
\`\`\`
something
\`\`\`
`;
    const patches = parseProposals(output);
    expect(patches).toHaveLength(0);
  });

  it('returns empty array for unparseable output', () => {
    expect(parseProposals('Some random LLM output with no patches')).toEqual([]);
  });

  it('accepts "Proposed Change" prefix', () => {
    const output = `
## Proposed Change 1
FIND:
\`\`\`
find me
\`\`\`
REPLACE:
\`\`\`
replace me
\`\`\`
`;
    const patches = parseProposals(output);
    expect(patches).toHaveLength(1);
  });
});

describe('buildAutoReflectionPrompt', () => {
  it('includes failure entries in the prompt', () => {
    const entries = [
      {
        id: 'test-1',
        timestamp: '2024-01-01T00:00:00Z',
        scenario: 'crashloop test',
        prompt: 'Why is the pod crashing?',
        failures: ['Severity: expected "critical", got "warning"'],
        suggestion: 'Strengthen severity signals',
      },
    ];
    const prompt = buildAutoReflectionPrompt(entries, [], 'const SUBAGENT_INSTRUCTIONS = `...`');
    expect(prompt).toContain('crashloop test');
    expect(prompt).toContain('Severity: expected "critical"');
    expect(prompt).toContain('FIND:');
    expect(prompt).toContain('REPLACE:');
    expect(prompt).toContain('NO_CHANGES_NEEDED');
  });

  it('includes the instructions snippet', () => {
    const prompt = buildAutoReflectionPrompt(
      [{ id: 'x', timestamp: '', scenario: 's', prompt: 'p', failures: ['f'], suggestion: 'sg' }],
      [],
      'MY_INSTRUCTIONS_CONTENT',
    );
    expect(prompt).toContain('MY_INSTRUCTIONS_CONTENT');
  });

  it('handles no failures gracefully', () => {
    const prompt = buildAutoReflectionPrompt([], [], 'instructions');
    expect(prompt).toContain('0 eval scenario');
  });

  it('includes a history section when taskHistory is non-empty', () => {
    const taskHistory = [
      {
        id: 'h1',
        timestamp: '2026-01-01T00:00:00Z',
        prompt: 'Why is the pod crashing?',
        model: 'anthropic/claude-sonnet-4-6',
        severity: 'critical',
        summary: 'OOMKilled due to memory limit',
      },
    ];
    const prompt = buildAutoReflectionPrompt([], taskHistory, 'instructions');
    expect(prompt).toContain('Recent Real-World Investigations');
  });
});

describe('extractInstructionsSnippet', () => {
  it('returns content unchanged when under 4000 chars', () => {
    const content = 'short content';
    expect(extractInstructionsSnippet(content)).toBe(content);
  });

  it('truncates long content with ellipsis', () => {
    const content = 'x'.repeat(5000);
    const snippet = extractInstructionsSnippet(content);
    expect(snippet.length).toBeLessThan(5000);
    expect(snippet).toContain('(truncated)');
  });

  it('tries to include SUBAGENT_INSTRUCTIONS section', () => {
    const prefix = 'a'.repeat(200);
    const content = prefix + 'SUBAGENT_INSTRUCTIONS = `something important`' + 'b'.repeat(200);
    const snippet = extractInstructionsSnippet(content);
    expect(snippet).toContain('SUBAGENT_INSTRUCTIONS');
  });

  it('starts the snippet at the earliest of RESPONSE_FORMAT or SUBAGENT_INSTRUCTIONS in a long string', () => {
    // The string must be >4000 chars so the early-return does not fire.
    const prefix = 'x'.repeat(500);
    const marker = 'RESPONSE_FORMAT = something important here';
    const suffix = 'y'.repeat(4000);
    const content = prefix + marker + suffix;
    const snippet = extractInstructionsSnippet(content);
    expect(snippet).toContain('RESPONSE_FORMAT');
    expect(snippet).toContain('(truncated)');
  });
});

// ---------------------------------------------------------------------------
// applyProposals
// ---------------------------------------------------------------------------

describe('applyProposals', () => {
  const PATH = '/fake/instructions.ts';

  it('applies a single matching patch and returns 1', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('hello world' as never);
    vi.mocked(writeFile).mockResolvedValueOnce(undefined as never);

    const count = await applyProposals([{ find: 'hello', replace: 'goodbye' }], PATH);

    expect(count).toBe(1);
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(PATH, 'goodbye world', 'utf8');
  });

  it('skips patch when find string is not present (0 occurrences)', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('hello world' as never);

    const count = await applyProposals([{ find: 'missing', replace: 'x' }], PATH);

    expect(count).toBe(0);
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  });

  it('skips patch when find string appears more than once (ambiguous)', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('foo foo bar' as never);

    const count = await applyProposals([{ find: 'foo', replace: 'baz' }], PATH);

    expect(count).toBe(0);
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  });

  it('applies multiple patches when each matches exactly once', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('alpha beta gamma' as never);
    vi.mocked(writeFile).mockResolvedValueOnce(undefined as never);

    const patches = [
      { find: 'alpha', replace: 'A' },
      { find: 'beta', replace: 'B' },
    ];
    const count = await applyProposals(patches, PATH);

    expect(count).toBe(2);
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(PATH, 'A B gamma', 'utf8');
  });

  it('does not write the file when no patches are applied', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('unchanged content' as never);

    const count = await applyProposals([], PATH);

    expect(count).toBe(0);
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  });

  it('writes the file exactly once even when multiple patches are applied', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('a b c' as never);
    vi.mocked(writeFile).mockResolvedValueOnce(undefined as never);

    await applyProposals(
      [
        { find: 'a', replace: 'X' },
        { find: 'b', replace: 'Y' },
        { find: 'c', replace: 'Z' },
      ],
      PATH,
    );

    expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(PATH, 'X Y Z', 'utf8');
  });
});

// ---------------------------------------------------------------------------
// revertToSnapshot
// ---------------------------------------------------------------------------

describe('revertToSnapshot', () => {
  const PATH = '/fake/instructions.ts';

  it('writes the snapshot content to the given path', async () => {
    vi.mocked(writeFile).mockResolvedValueOnce(undefined as never);

    await revertToSnapshot('original content', PATH);

    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(PATH, 'original content', 'utf8');
  });
});

// ---------------------------------------------------------------------------
// snapshotInstructions
// ---------------------------------------------------------------------------

describe('snapshotInstructions', () => {
  const PATH = '/fake/instructions.ts';

  it('returns the file content as a string', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('snapshot content' as never);

    const result = await snapshotInstructions(PATH);

    expect(result).toBe('snapshot content');
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(PATH, 'utf8');
  });
});

// ---------------------------------------------------------------------------
// formatPct
// ---------------------------------------------------------------------------

describe('formatPct', () => {
  it('formats a 0-1 fraction as a whole-percent string', () => {
    expect(formatPct(0)).toBe('0%');
    expect(formatPct(1)).toBe('100%');
    expect(formatPct(0.5)).toBe('50%');
    expect(formatPct(2 / 3)).toBe('67%');
  });
});

// ---------------------------------------------------------------------------
// buildStartupBanner
// ---------------------------------------------------------------------------

describe('buildStartupBanner', () => {
  it('pluralizes "iterations" when maxIterations is not 1', () => {
    const banner = buildStartupBanner(3, 'claude-cli', 5, false);
    expect(banner).toBe(
      '\nHeimdall Self-Loop (max 3 iterations)\n' +
      'Backend: claude-cli | Scenarios: 5 | Mode: apply\n' +
      '='.repeat(60) + '\n\n',
    );
  });

  it('uses singular "iteration" when maxIterations is 1', () => {
    const banner = buildStartupBanner(1, 'codex-cli', 2, true);
    expect(banner).toContain('max 1 iteration)');
    expect(banner).not.toContain('iterations)');
  });

  it('shows dry-run mode label when dryRun is true', () => {
    expect(buildStartupBanner(3, 'claude-cli', 5, true)).toContain('Mode: dry-run\n');
  });

  it('shows apply mode label when dryRun is false', () => {
    expect(buildStartupBanner(3, 'claude-cli', 5, false)).toContain('Mode: apply\n');
  });
});

// ---------------------------------------------------------------------------
// formatDryRunPreview
// ---------------------------------------------------------------------------

describe('formatDryRunPreview', () => {
  it('formats a single patch with truncated FIND/REPLACE previews', () => {
    const preview = formatDryRunPreview([{ find: 'old text', replace: 'new text' }]);
    expect(preview).toBe(
      '\n[dry-run] Proposed patches:\n' +
      '  Patch 1:\n    FIND: old text...\n    REPLACE: new text...\n' +
      '\n[dry-run] Not applying patches. Stopping.\n',
    );
  });

  it('numbers multiple patches sequentially starting at 1', () => {
    const preview = formatDryRunPreview([
      { find: 'a', replace: 'A' },
      { find: 'b', replace: 'B' },
    ]);
    expect(preview).toContain('  Patch 1:\n    FIND: a...\n    REPLACE: A...\n');
    expect(preview).toContain('  Patch 2:\n    FIND: b...\n    REPLACE: B...\n');
  });

  it('truncates FIND/REPLACE text longer than 80 characters', () => {
    const long = 'x'.repeat(100);
    const preview = formatDryRunPreview([{ find: long, replace: long }]);
    expect(preview).toContain(`FIND: ${'x'.repeat(80)}...\n`);
    expect(preview).toContain(`REPLACE: ${'x'.repeat(80)}...\n`);
  });

  it('escapes embedded newlines as literal \\n', () => {
    const preview = formatDryRunPreview([{ find: 'line1\nline2', replace: 'r1\nr2' }]);
    expect(preview).toContain('FIND: line1\\nline2...\n');
    expect(preview).toContain('REPLACE: r1\\nr2...\n');
  });
});

// ---------------------------------------------------------------------------
// formatScoreChangeLine
// ---------------------------------------------------------------------------

describe('formatScoreChangeLine', () => {
  it('prefixes a "+" for an improving score', () => {
    expect(formatScoreChangeLine(0.5, 0.75, true)).toBe('Score: 50% → 75% (+25pp)\n');
  });

  it('omits the "+" for a non-improving score', () => {
    expect(formatScoreChangeLine(0.75, 0.5, false)).toBe('Score: 75% → 50% (-25pp)\n');
  });

  it('omits the "+" for an unchanged score', () => {
    expect(formatScoreChangeLine(0.5, 0.5, false)).toBe('Score: 50% → 50% (0pp)\n');
  });
});

// ---------------------------------------------------------------------------
// buildSummaryReport
// ---------------------------------------------------------------------------

describe('buildSummaryReport', () => {
  function result(overrides: Partial<IterationResult>): IterationResult {
    return {
      iteration: 1,
      baselineScore: 0.5,
      newScore: 0.5,
      proposalCount: 1,
      appliedCount: 1,
      improved: false,
      reverted: false,
      ...overrides,
    };
  }

  it('reports "no iterations" when the history is empty', () => {
    const report = buildSummaryReport([], 0.5, '/fake/learning-log.jsonl');

    expect(report).toBe(
      '='.repeat(60) + '\n' +
      'Self-Loop Summary\n' +
      '='.repeat(60) + '\n' +
      'No iterations were run (all scenarios already passing or LLM unavailable).\n' +
      '\nProposals saved to: scenarios/self-loop-proposals/\n' +
      'Learning entries saved to: /fake/learning-log.jsonl\n',
    );
  });

  it('formats a kept, improving iteration with a "+" delta and singular "patch"', () => {
    const history = [
      result({ iteration: 1, baselineScore: 0.5, newScore: 0.75, appliedCount: 1, improved: true, reverted: false }),
    ];

    const report = buildSummaryReport(history, 0.75, '/fake/learning-log.jsonl');

    expect(report).toContain('  Iteration 1: 50% → 75% (+25pp) | 1 patch | KEPT\n');
    expect(report).toContain('\nFinal score: 75%\n');
    expect(report).toContain('instructions.ts was updated. Review changes with: git diff src/lib/instructions.ts\n');
  });

  it('formats a reverted, non-improving iteration with no "+" and plural "patches"', () => {
    const history = [
      result({ iteration: 2, baselineScore: 0.75, newScore: 0.5, appliedCount: 2, improved: false, reverted: true }),
    ];

    const report = buildSummaryReport(history, 0.75, '/fake/learning-log.jsonl');

    expect(report).toContain('  Iteration 2: 75% → 50% (-25pp) | 2 patches | REVERTED\n');
    expect(report).not.toContain('instructions.ts was updated');
  });

  it('reports NO_CHANGE for an unimproved, non-reverted iteration (e.g. zero patches parsed)', () => {
    const history = [
      result({ iteration: 1, baselineScore: 0.5, newScore: 0.5, proposalCount: 0, appliedCount: 0, improved: false, reverted: false }),
    ];

    const report = buildSummaryReport(history, 0.5, '/fake/learning-log.jsonl');

    expect(report).toContain('  Iteration 1: 50% → 50% (+0pp) | 0 patches | NO_CHANGE\n');
  });

  it('normalizes a tiny negative delta that rounds to "-0" instead of showing "+-0pp"', () => {
    const history = [
      result({ iteration: 1, baselineScore: 0.505, newScore: 0.5005, improved: false, reverted: true }),
    ];

    const report = buildSummaryReport(history, 0.505, '/fake/learning-log.jsonl');

    expect(report).toContain('(+0pp)');
    expect(report).not.toContain('+-0pp');
    expect(report).not.toContain('(-0pp)');
  });

  it('always includes the proposals and learning-log footer lines', () => {
    const report = buildSummaryReport([result({})], 0.5, '/some/path/log.jsonl');

    expect(report).toContain('\nProposals saved to: scenarios/self-loop-proposals/\n');
    expect(report).toContain('Learning entries saved to: /some/path/log.jsonl\n');
  });
});
