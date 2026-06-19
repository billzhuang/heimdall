import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateSuggestion,
  buildLearningEntry,
  buildReflectionPrompt,
  readLearningLog,
  appendLearningEntry,
  resolveLogPath,
} from '../self-improve.ts';

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
