import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: vi.fn(), writeFile: vi.fn() };
});

import { readFile, writeFile } from 'node:fs/promises';
import {
  scoreResults,
  parseProposals,
  buildAutoReflectionPrompt,
  extractInstructionsSnippet,
  applyProposals,
  revertToSnapshot,
  snapshotInstructions,
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
});

// ---------------------------------------------------------------------------
// applyProposals
// ---------------------------------------------------------------------------

describe('applyProposals', () => {
  const PATH = '/fake/instructions.ts';

  beforeEach(() => {
    vi.mocked(readFile).mockReset();
    vi.mocked(writeFile).mockReset();
  });

  afterEach(() => {
    vi.mocked(readFile).mockReset();
    vi.mocked(writeFile).mockReset();
  });

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
  });
});

// ---------------------------------------------------------------------------
// revertToSnapshot
// ---------------------------------------------------------------------------

describe('revertToSnapshot', () => {
  const PATH = '/fake/instructions.ts';

  beforeEach(() => {
    vi.mocked(writeFile).mockReset();
  });

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

  beforeEach(() => {
    vi.mocked(readFile).mockReset();
  });

  it('returns the file content as a string', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('snapshot content' as never);

    const result = await snapshotInstructions(PATH);

    expect(result).toBe('snapshot content');
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(PATH, 'utf8');
  });
});
