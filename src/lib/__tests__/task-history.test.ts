import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildTaskHistoryEntry,
  appendTaskHistoryEntry,
  readTaskHistory,
  buildTaskHistoryContext,
  formatTaskHistoryEntry,
  resolveTaskHistoryFilePath,
  type TaskHistoryEntry,
} from '../task-history.ts';

// ---------------------------------------------------------------------------
// resolveTaskHistoryFilePath
// ---------------------------------------------------------------------------
describe('resolveTaskHistoryFilePath', () => {
  it('joins scenariosDir with task-history.jsonl when no file is configured', () => {
    expect(resolveTaskHistoryFilePath(undefined, '/scenarios', '/config')).toBe(join('/scenarios', 'task-history.jsonl'));
    expect(resolveTaskHistoryFilePath(null, '/scenarios', '/config')).toBe(join('/scenarios', 'task-history.jsonl'));
    expect(resolveTaskHistoryFilePath('', '/scenarios', '/config')).toBe(join('/scenarios', 'task-history.jsonl'));
  });

  it('resolves a configured absolute path as-is, ignoring scenariosDir and baseDir', () => {
    expect(resolveTaskHistoryFilePath('/custom/history.jsonl', '/scenarios', '/config')).toBe('/custom/history.jsonl');
  });

  it('resolves a configured relative path against baseDir, not scenariosDir or cwd', () => {
    expect(resolveTaskHistoryFilePath('custom/history.jsonl', '/scenarios', '/config')).toBe(
      resolve('/config', 'custom/history.jsonl'),
    );
  });
});

// ---------------------------------------------------------------------------
// buildTaskHistoryEntry
// ---------------------------------------------------------------------------
describe('buildTaskHistoryEntry', () => {
  it('returns an entry with all required fields', () => {
    const entry = buildTaskHistoryEntry('why is my pod crashing?', 'test-model', 'warning', 'CrashLoopBackOff detected');
    expect(entry.prompt).toBe('why is my pod crashing?');
    expect(entry.model).toBe('test-model');
    expect(entry.severity).toBe('warning');
    expect(entry.summary).toBe('CrashLoopBackOff detected');
    expect(typeof entry.id).toBe('string');
    expect(entry.id).toMatch(/^\d+-[0-9a-f]{12}$/);
    expect(Date.parse(entry.timestamp)).not.toBeNaN();
  });

  it('generates unique IDs for entries created in the same millisecond', () => {
    const ids = new Set(
      Array.from({ length: 20 }, () =>
        buildTaskHistoryEntry('p', 'm', 's', 'summary').id,
      ),
    );
    expect(ids.size).toBe(20);
  });

  it('handles empty strings without throwing', () => {
    const entry = buildTaskHistoryEntry('', '', '', '');
    expect(entry.prompt).toBe('');
    expect(entry.summary).toBe('');
  });
});

// ---------------------------------------------------------------------------
// appendTaskHistoryEntry + readTaskHistory
// ---------------------------------------------------------------------------
describe('appendTaskHistoryEntry / readTaskHistory', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = join(tmpdir(), `task-history-test-${Date.now()}.jsonl`);
  });

  afterEach(async () => {
    await rm(tmpFile, { force: true });
  });

  it('returns empty array when file does not exist', async () => {
    const entries = await readTaskHistory(tmpFile + '.nonexistent');
    expect(entries).toEqual([]);
  });

  it('writes and reads back a single entry', async () => {
    const entry = buildTaskHistoryEntry('test prompt', 'model-x', 'info', 'all good');
    await appendTaskHistoryEntry(entry, tmpFile);
    const entries = await readTaskHistory(tmpFile);
    expect(entries).toHaveLength(1);
    expect(entries[0].prompt).toBe('test prompt');
    expect(entries[0].model).toBe('model-x');
    expect(entries[0].severity).toBe('info');
    expect(entries[0].summary).toBe('all good');
  });

  it('appends multiple entries in order', async () => {
    const e1 = buildTaskHistoryEntry('first', 'm', 'info', 's1');
    const e2 = buildTaskHistoryEntry('second', 'm', 'warning', 's2');
    const e3 = buildTaskHistoryEntry('third', 'm', 'critical', 's3');
    await appendTaskHistoryEntry(e1, tmpFile);
    await appendTaskHistoryEntry(e2, tmpFile);
    await appendTaskHistoryEntry(e3, tmpFile);
    const entries = await readTaskHistory(tmpFile);
    expect(entries).toHaveLength(3);
    expect(entries.map(e => e.prompt)).toEqual(['first', 'second', 'third']);
  });

  it('skips malformed JSONL lines without crashing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const good = buildTaskHistoryEntry('ok', 'm', 'info', 's');
    await writeFile(tmpFile, `not-valid-json\n${JSON.stringify(good)}\n{broken\n`, 'utf8');
    const entries = await readTaskHistory(tmpFile);
    expect(entries).toHaveLength(1);
    expect(entries[0].prompt).toBe('ok');
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('malformed JSONL'));
    warnSpy.mockRestore();
  });

  it('skips blank lines', async () => {
    const e = buildTaskHistoryEntry('q', 'm', 'info', 's');
    await writeFile(tmpFile, `\n\n${JSON.stringify(e)}\n\n`, 'utf8');
    const entries = await readTaskHistory(tmpFile);
    expect(entries).toHaveLength(1);
  });

  it('returns empty array for a whitespace-only file', async () => {
    await writeFile(tmpFile, '   \n\t\n  \n', 'utf8');
    const entries = await readTaskHistory(tmpFile);
    expect(entries).toEqual([]);
  });

  it('rethrows non-ENOENT errors from readFile', async () => {
    await expect(readTaskHistory('/dev/null/impossible/path')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// formatTaskHistoryEntry
// ---------------------------------------------------------------------------
describe('formatTaskHistoryEntry', () => {
  const entry: TaskHistoryEntry = {
    id: 'test-id',
    timestamp: '2026-06-19T10:00:00.000Z',
    prompt: 'why is the service slow?',
    model: 'test-model',
    severity: 'warning',
    summary: 'High CPU utilization detected on api-deployment',
  };

  it('formats a numbered Markdown block with all expected fields', () => {
    const out = formatTaskHistoryEntry(entry, 0);
    expect(out).toContain('### 1. "why is the service slow?"');
    expect(out).toContain('**Date**: 2026-06-19T10:00:00.000Z');
    expect(out).toContain('**Severity**: warning');
    expect(out).toContain('**Summary**: High CPU utilization detected on api-deployment');
  });

  it('numbers using index + 1', () => {
    expect(formatTaskHistoryEntry(entry, 4)).toContain('### 5.');
  });
});

// ---------------------------------------------------------------------------
// buildTaskHistoryContext
// ---------------------------------------------------------------------------
describe('buildTaskHistoryContext', () => {
  it('returns a placeholder message when entries array is empty', () => {
    const out = buildTaskHistoryContext([]);
    expect(out).toContain('No task history entries yet');
  });

  it('formats a single entry with all expected fields', () => {
    const entry: TaskHistoryEntry = {
      id: 'test-id',
      timestamp: '2026-06-19T10:00:00.000Z',
      prompt: 'why is the service slow?',
      model: 'test-model',
      severity: 'warning',
      summary: 'High CPU utilization detected on api-deployment',
    };
    const out = buildTaskHistoryContext([entry]);
    expect(out).toContain('why is the service slow?');
    expect(out).toContain('warning');
    expect(out).toContain('High CPU utilization detected');
    expect(out).toContain('2026-06-19T10:00:00.000Z');
  });

  it('caps output at maxEntries (default 20)', () => {
    const entries: TaskHistoryEntry[] = Array.from({ length: 30 }, (_, i) => ({
      id: `id-${i}`,
      timestamp: new Date().toISOString(),
      prompt: `prompt-${i}`,
      model: 'm',
      severity: 'info',
      summary: `summary-${i}`,
    }));
    const out = buildTaskHistoryContext(entries);
    // Only the last 20 entries should appear (prompt-10 through prompt-29).
    expect(out).toContain('prompt-10');
    expect(out).not.toContain('prompt-9');
  });

  it('respects custom maxEntries', () => {
    const entries: TaskHistoryEntry[] = Array.from({ length: 10 }, (_, i) => ({
      id: `id-${i}`,
      timestamp: new Date().toISOString(),
      prompt: `prompt-${i}`,
      model: 'm',
      severity: 'info',
      summary: `summary-${i}`,
    }));
    const out = buildTaskHistoryContext(entries, 3);
    expect(out).toContain('prompt-7');
    expect(out).not.toContain('prompt-6');
  });

  it('formats multiple entries with numbered headings', () => {
    const entries: TaskHistoryEntry[] = [
      { id: 'a', timestamp: 't', prompt: 'p1', model: 'm', severity: 'info', summary: 's1' },
      { id: 'b', timestamp: 't', prompt: 'p2', model: 'm', severity: 'critical', summary: 's2' },
    ];
    const out = buildTaskHistoryContext(entries);
    expect(out).toContain('### 1.');
    expect(out).toContain('### 2.');
  });

  it('returns placeholder when maxEntries is 0 (guards the slice(-0)=slice(0) pitfall)', () => {
    const entries: TaskHistoryEntry[] = [
      { id: 'a', timestamp: 't', prompt: 'p1', model: 'm', severity: 'info', summary: 's1' },
    ];
    // entries.slice(-0) === entries.slice(0) → would return all entries without the fix
    const out = buildTaskHistoryContext(entries, 0);
    expect(out).toBe('No task history entries yet.');
  });

  it('returns all entries when maxEntries exceeds the array length', () => {
    const entries: TaskHistoryEntry[] = [
      { id: 'a', timestamp: 't', prompt: 'p1', model: 'm', severity: 'info', summary: 's1' },
      { id: 'b', timestamp: 't', prompt: 'p2', model: 'm', severity: 'warning', summary: 's2' },
    ];
    const out = buildTaskHistoryContext(entries, 100);
    expect(out).toContain('p1');
    expect(out).toContain('p2');
    expect(out).toContain('### 1.');
    expect(out).toContain('### 2.');
  });
});
