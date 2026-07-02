import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateSuggestion,
  buildLearningEntry,
  buildReflectionPrompt,
  formatLearningEntries,
  readLearningLog,
  appendLearningEntry,
  resolveLogPath,
  resolveRagOptions,
} from '../self-improve.ts';
import type { HeimdallConfig } from '../config.ts';
import type { TaskHistoryEntry } from '../task-history.ts';

function makeHistoryEntry(prompt: string, summary: string): TaskHistoryEntry {
  return { id: `id-${prompt}`, timestamp: '2026-01-01T00:00:00.000Z', prompt, model: 'test-model', severity: 'info', summary };
}

describe('generateSuggestion', () => {
  it('returns fallback for empty failures array', () => {
    expect(generateSuggestion('Scenario', 'prompt', [])).toBe(
      'No actionable suggestion generated.',
    );
  });

  it('handles severity mismatch', () => {
    const s = generateSuggestion(
      'OOM scenario',
      'Why is my pod OOMKilled?',
      ['Severity: expected "critical", got "warning"'],
    );
    expect(s).toContain('Severity miscalibrated');
    expect(s).toContain('critical');
    expect(s).toContain('warning');
  });

  it('handles missing expected keyword', () => {
    const s = generateSuggestion(
      'CrashLoop scenario',
      'Debug crashloop',
      ['Missing expected keyword: "imagepullbackoff"'],
    );
    expect(s).toContain('"imagepullbackoff"');
    expect(s).toContain('Focus section');
  });

  it('handles forbidden keyword', () => {
    const s = generateSuggestion(
      'RBAC scenario',
      'Audit RBAC',
      ['Found forbidden keyword: "delete"'],
    );
    expect(s).toContain('"delete"');
    expect(s).toContain('constraint');
  });

  it('handles agent error', () => {
    const s = generateSuggestion('Scenario', 'prompt', ['Agent error: exit code 1']);
    expect(s).toContain('Agent execution failed');
  });

  it('handles unrecognised failure format', () => {
    const s = generateSuggestion('Scenario', 'prompt', ['Some unknown failure message']);
    expect(s).toContain('Some unknown failure message');
  });

  it('joins multiple failures with separator', () => {
    const s = generateSuggestion('Scenario', 'prompt', [
      'Missing expected keyword: "foo"',
      'Missing expected keyword: "bar"',
    ]);
    expect(s).toContain('"foo"');
    expect(s).toContain('"bar"');
    expect(s).toContain(' | ');
  });
});

describe('formatLearningEntries', () => {
  it('returns an empty string for an empty array', () => {
    expect(formatLearningEntries([])).toBe('');
  });

  it('formats a single entry with numbered heading, prompt, failures, and suggestion', () => {
    const entry = buildLearningEntry('CrashLoop', 'Why is the pod crashing?', [
      'Missing expected keyword: "imagepullbackoff"',
    ]);
    const out = formatLearningEntries([entry]);
    expect(out).toContain('### 1. "CrashLoop"');
    expect(out).toContain('**Prompt**: Why is the pod crashing?');
    expect(out).toContain('**Failures**:');
    expect(out).toContain('- Missing expected keyword: "imagepullbackoff"');
    expect(out).toContain('**Auto-suggestion**:');
  });

  it('formats multiple entries with sequential numbered headings', () => {
    const e1 = buildLearningEntry('A', 'pa', ['Agent error: exit 1']);
    const e2 = buildLearningEntry('B', 'pb', ['Missing expected keyword: "x"']);
    const out = formatLearningEntries([e1, e2]);
    expect(out).toContain('### 1. "A"');
    expect(out).toContain('### 2. "B"');
  });

  it('joins multiple entries with a blank line separator', () => {
    const e1 = buildLearningEntry('X', 'p1', ['f1']);
    const e2 = buildLearningEntry('Y', 'p2', ['f2']);
    const out = formatLearningEntries([e1, e2]);
    expect(out).toContain('\n\n');
  });

  it('lists each failure as a dash bullet on its own line', () => {
    const entry = buildLearningEntry('Multi', 'prompt', [
      'Missing expected keyword: "foo"',
      'Found forbidden keyword: "bar"',
    ]);
    const out = formatLearningEntries([entry]);
    expect(out).toContain('- Missing expected keyword: "foo"');
    expect(out).toContain('- Found forbidden keyword: "bar"');
  });
});

describe('buildLearningEntry', () => {
  it('includes all required fields', () => {
    const entry = buildLearningEntry('Test scenario', 'What is wrong?', ['Missing keyword: "foo"']);
    expect(entry.id).toBeTruthy();
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.scenario).toBe('Test scenario');
    expect(entry.prompt).toBe('What is wrong?');
    expect(entry.failures).toEqual(['Missing keyword: "foo"']);
    expect(typeof entry.suggestion).toBe('string');
  });

  it('generates unique IDs for separate calls', () => {
    const e1 = buildLearningEntry('S1', 'P1', []);
    const e2 = buildLearningEntry('S2', 'P2', []);
    expect(e1.id).not.toBe(e2.id);
  });
});

describe('buildReflectionPrompt', () => {
  it('returns no-failure message when entries is empty', () => {
    expect(buildReflectionPrompt([])).toContain('No failures to reflect on');
  });

  it('includes scenario names and failure details', () => {
    const entries = [
      buildLearningEntry('CrashLoop', 'Why crashing?', [
        'Missing expected keyword: "imagepullbackoff"',
      ]),
    ];
    const prompt = buildReflectionPrompt(entries);
    expect(prompt).toContain('CrashLoop');
    expect(prompt).toContain('imagepullbackoff');
    expect(prompt).toContain('src/lib/instructions.ts');
  });

  it('lists all entries', () => {
    const entries = [
      buildLearningEntry('A', 'pa', ['Missing expected keyword: "x"']),
      buildLearningEntry('B', 'pb', ['Missing expected keyword: "y"']),
    ];
    const prompt = buildReflectionPrompt(entries);
    expect(prompt).toContain('"A"');
    expect(prompt).toContain('"B"');
    expect(prompt).toContain('2 eval scenarios');
  });
});

describe('readLearningLog', () => {
  it('returns empty array for non-existent file', async () => {
    const entries = await readLearningLog('/nonexistent/path/learning-log.jsonl');
    expect(entries).toEqual([]);
  });

  it('reads and parses JSONL entries', async () => {
    const tmpPath = join(tmpdir(), `test-learning-log-${Date.now()}.jsonl`);
    const entry = buildLearningEntry('Test scenario', 'my prompt', ['Agent error: timeout']);
    await writeFile(tmpPath, JSON.stringify(entry) + '\n', 'utf8');
    try {
      const entries = await readLearningLog(tmpPath);
      expect(entries).toHaveLength(1);
      expect(entries[0].scenario).toBe('Test scenario');
      expect(entries[0].prompt).toBe('my prompt');
    } finally {
      await unlink(tmpPath).catch(() => undefined);
    }
  });

  it('skips malformed JSONL lines gracefully', async () => {
    const tmpPath = join(tmpdir(), `test-learning-log-malformed-${Date.now()}.jsonl`);
    const entry = buildLearningEntry('Test', 'prompt', ['failure']);
    await writeFile(tmpPath, JSON.stringify(entry) + '\n{not-valid-json}\n', 'utf8');
    try {
      const entries = await readLearningLog(tmpPath);
      expect(entries).toHaveLength(1);
    } finally {
      await unlink(tmpPath).catch(() => undefined);
    }
  });
});

describe('resolveLogPath', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns defaultPath when nothing is set', () => {
    vi.stubEnv('HEIMDALL_LEARNING_LOG', '');
    expect(resolveLogPath(undefined, undefined, '/default/path')).toBe('/default/path');
  });

  it('cli --log-path takes highest priority', () => {
    vi.stubEnv('HEIMDALL_LEARNING_LOG', '/env/path.jsonl');
    const result = resolveLogPath('/cli/path.jsonl', '/config/path.jsonl', '/default/path');
    expect(result).toBe(resolve('/cli/path.jsonl'));
  });

  it('HEIMDALL_LEARNING_LOG env var takes priority over config and default', () => {
    vi.stubEnv('HEIMDALL_LEARNING_LOG', '/env/path.jsonl');
    const result = resolveLogPath(undefined, '/config/path.jsonl', '/default/path');
    expect(result).toBe(resolve('/env/path.jsonl'));
  });

  it('config logFile takes priority over default when env is unset', () => {
    vi.stubEnv('HEIMDALL_LEARNING_LOG', '');
    const result = resolveLogPath(undefined, '/config/path.jsonl', '/default/path');
    expect(result).toBe(resolve('/config/path.jsonl'));
  });

  it('resolves relative cli path to absolute', () => {
    vi.stubEnv('HEIMDALL_LEARNING_LOG', '');
    const result = resolveLogPath('relative/log.jsonl', undefined, '/default/path');
    expect(result).toBe(resolve('relative/log.jsonl'));
    expect(result.startsWith('/')).toBe(true);
  });

  it('resolves relative env path to absolute', () => {
    vi.stubEnv('HEIMDALL_LEARNING_LOG', 'relative/env-log.jsonl');
    const result = resolveLogPath(undefined, undefined, '/default/path');
    expect(result).toBe(resolve('relative/env-log.jsonl'));
    expect(result.startsWith('/')).toBe(true);
  });
});

describe('resolveRagOptions', () => {
  it('maps the validated rag.enabled=false default straight through', () => {
    const config: HeimdallConfig['learning'] = {
      enabled: true,
      rag: { enabled: false, topK: 5, minSimilarity: 0 },
    };
    expect(resolveRagOptions(config)).toEqual({ useRag: false, ragTopK: 5 });
  });

  it('maps enabled RAG and a non-default topK straight through', () => {
    const config: HeimdallConfig['learning'] = {
      enabled: true,
      rag: { enabled: true, topK: 25, minSimilarity: 0 },
    };
    expect(resolveRagOptions(config)).toEqual({ useRag: true, ragTopK: 25 });
  });
});

describe('buildReflectionPrompt — with task history only', () => {
  it('returns no-failure message and history section when entries is empty but taskHistory is provided', () => {
    const history = [makeHistoryEntry('Debug OOMKill', 'OOM on payment pod at 14:32')];
    const prompt = buildReflectionPrompt([], history);
    expect(prompt).toContain('No eval failures this run.');
    expect(prompt).toContain('Real-World Investigations');
    expect(prompt).toContain('Debug OOMKill');
  });

  it('includes items 3 and 4 in Your task section when only taskHistory is provided', () => {
    const history = [makeHistoryEntry('Debug CrashLoop', 'pod keeps restarting')];
    const prompt = buildReflectionPrompt([], history);
    expect(prompt).toContain('Coverage gaps');
    expect(prompt).toContain('Severity calibration');
  });

  it('does not include scenario list items 1 and 2 when entries is empty', () => {
    const history = [makeHistoryEntry('Some prompt', 'some summary')];
    const prompt = buildReflectionPrompt([], history);
    expect(prompt).not.toContain('Root cause');
    expect(prompt).not.toContain('Instruction fix');
  });
});

describe('buildReflectionPrompt — entries plus task history', () => {
  it('includes both scenario list and history section', () => {
    const entry = buildLearningEntry('CrashLoop', 'Why crashing?', ['Missing expected keyword: "imagepullbackoff"']);
    const history = [makeHistoryEntry('Debug OOM', 'payment pod OOM')];
    const prompt = buildReflectionPrompt([entry], history);
    expect(prompt).toContain('CrashLoop');
    expect(prompt).toContain('Real-World Investigations');
    expect(prompt).toContain('Debug OOM');
  });

  it('includes all four task items when entries and taskHistory are both present', () => {
    const entry = buildLearningEntry('Scenario', 'prompt', ['Agent error: timeout']);
    const history = [makeHistoryEntry('Some prompt', 'some summary')];
    const prompt = buildReflectionPrompt([entry], history);
    expect(prompt).toContain('Root cause');
    expect(prompt).toContain('Instruction fix');
    expect(prompt).toContain('Coverage gaps');
    expect(prompt).toContain('Severity calibration');
  });
});

describe('buildReflectionPrompt — RAG mode', () => {
  it('uses "semantically similar" label when useRag is true and entries are present', () => {
    const entry = buildLearningEntry('OOM', 'pod oom', ['Agent error: timeout']);
    const history = [makeHistoryEntry('Debug OOM', 'payment pod oom kill')];
    const prompt = buildReflectionPrompt([entry], history, true);
    expect(prompt).toContain('semantically similar to the failing scenario prompts');
  });

  it('uses "most recent" label when useRag is false', () => {
    const entry = buildLearningEntry('OOM', 'pod oom', ['Agent error: timeout']);
    const history = [makeHistoryEntry('Debug OOM', 'payment pod oom kill')];
    const prompt = buildReflectionPrompt([entry], history, false);
    expect(prompt).toContain('most recent');
  });
});

describe('buildReflectionPrompt — singular/plural scenario count', () => {
  it('uses singular "1 eval scenario" for a single failure', () => {
    const entry = buildLearningEntry('Solo', 'prompt', ['Agent error: exit 1']);
    const prompt = buildReflectionPrompt([entry]);
    expect(prompt).toContain('failed 1 eval scenario.');
  });

  it('uses plural "eval scenarios" for multiple failures', () => {
    const e1 = buildLearningEntry('A', 'pa', ['Agent error: exit 1']);
    const e2 = buildLearningEntry('B', 'pb', ['Agent error: exit 1']);
    const prompt = buildReflectionPrompt([e1, e2]);
    expect(prompt).toContain('2 eval scenarios');
  });
});

describe('generateSuggestion — Severity prefix without matching pattern', () => {
  it('returns empty string when Severity: prefix has no expected/got pattern', () => {
    const s = generateSuggestion('Scenario', 'prompt', ['Severity: something unrecognised']);
    expect(s).toBe('');
  });
});

describe('generateSuggestion — missing/forbidden keyword without quoted string', () => {
  it('returns empty string when "Missing expected keyword:" has no quoted keyword', () => {
    const s = generateSuggestion('Scenario', 'prompt', ['Missing expected keyword: no-quotes-here']);
    expect(s).toBe('');
  });

  it('returns empty string when "Found forbidden keyword:" has no quoted keyword', () => {
    const s = generateSuggestion('Scenario', 'prompt', ['Found forbidden keyword: no-quotes-here']);
    expect(s).toBe('');
  });
});

describe('readLearningLog — non-ENOENT error', () => {
  it('rethrows non-ENOENT errors (e.g. EISDIR when path is a directory)', async () => {
    await expect(readLearningLog('/tmp')).rejects.toThrow();
  });
});

describe('appendLearningEntry', () => {
  it('creates the file and appends valid JSONL', async () => {
    const tmpPath = join(tmpdir(), `test-append-${Date.now()}.jsonl`);
    const entry = buildLearningEntry('AppendTest', 'append prompt', ['failure']);
    await appendLearningEntry(entry, tmpPath);
    try {
      const entries = await readLearningLog(tmpPath);
      expect(entries).toHaveLength(1);
      expect(entries[0].scenario).toBe('AppendTest');
    } finally {
      await unlink(tmpPath).catch(() => undefined);
    }
  });

  it('appends multiple entries to the same file', async () => {
    const tmpPath = join(tmpdir(), `test-append-multi-${Date.now()}.jsonl`);
    const e1 = buildLearningEntry('E1', 'p1', ['f1']);
    const e2 = buildLearningEntry('E2', 'p2', ['f2']);
    await appendLearningEntry(e1, tmpPath);
    await appendLearningEntry(e2, tmpPath);
    try {
      const entries = await readLearningLog(tmpPath);
      expect(entries).toHaveLength(2);
      expect(entries[0].scenario).toBe('E1');
      expect(entries[1].scenario).toBe('E2');
    } finally {
      await unlink(tmpPath).catch(() => undefined);
    }
  });
});
