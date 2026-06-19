import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tagsMatch, loadRunbooks } from '../runbooks.ts';

// ── tagsMatch ────────────────────────────────────────────────────────────────

describe('tagsMatch', () => {
  it('returns true when tags is empty (untagged → always match)', () => {
    expect(tagsMatch([], 'any query')).toBe(true);
  });

  it('returns true when tags is null', () => {
    expect(tagsMatch(null, 'anything')).toBe(true);
  });

  it('returns true when tags is undefined', () => {
    expect(tagsMatch(undefined, 'query')).toBe(true);
  });

  it('matches a tag present in the query (case-insensitive)', () => {
    expect(tagsMatch(['latency'], 'API latency is high')).toBe(true);
    expect(tagsMatch(['LATENCY'], 'api latency is high')).toBe(true);
  });

  it('returns false when no tag matches the query', () => {
    expect(tagsMatch(['oom', 'memory'], 'DNS resolution failure')).toBe(false);
  });

  it('matches any one of multiple tags', () => {
    expect(tagsMatch(['oom', 'latency'], 'OOM killed pod')).toBe(true);
  });

  it('does not match a tag as a substring of a longer word', () => {
    expect(tagsMatch(['api'], 'rapid response')).toBe(false);
  });

  it('matches a tag that is a whole word adjacent to punctuation', () => {
    expect(tagsMatch(['api'], 'the api is down')).toBe(true);
  });
});

// ── loadRunbooks ─────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'heimdall-runbooks-test-'));
}

describe('loadRunbooks', () => {
  it('returns empty string when configs array is empty', () => {
    expect(loadRunbooks('/any', [])).toBe('');
  });

  it('returns empty string when configs is null/undefined-like', () => {
    // @ts-expect-error testing null input defensively
    expect(loadRunbooks('/any', null)).toBe('');
  });

  it('loads a single untagged runbook', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'general.md'), '# General\nCheck the pods first.');
    const result = loadRunbooks(dir, [{ path: 'general.md' }]);
    expect(result).toContain('Check the pods first.');
    expect(result).toContain('Runbook: general.md');
  });

  it('loads runbooks with matching tags when query is given', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'latency.md'), '# Latency\nCheck DB pool.');
    writeFileSync(join(dir, 'oom.md'), '# OOM\nCheck memory limits.');
    const result = loadRunbooks(dir, [
      { path: 'latency.md', tags: ['latency', 'api'] },
      { path: 'oom.md', tags: ['oom', 'memory'] },
    ], 'api latency is high');
    expect(result).toContain('Check DB pool.');
    expect(result).not.toContain('Check memory limits.');
  });

  it('skips tagged runbooks when no tag matches the query', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'latency.md'), '# Latency runbook');
    const result = loadRunbooks(dir, [
      { path: 'latency.md', tags: ['latency'] },
    ], 'pod crashloopbackoff restart');
    expect(result).toBe('');
  });

  it('always loads untagged runbooks even when a query is given', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'general.md'), '# General steps');
    const result = loadRunbooks(dir, [
      { path: 'general.md', tags: [] },
    ], 'something unrelated');
    expect(result).toContain('General steps');
  });

  it('loads all runbooks when no query is given', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'a.md'), 'Runbook A');
    writeFileSync(join(dir, 'b.md'), 'Runbook B');
    const result = loadRunbooks(dir, [
      { path: 'a.md', tags: ['latency'] },
      { path: 'b.md', tags: ['oom'] },
    ]);
    expect(result).toContain('Runbook A');
    expect(result).toContain('Runbook B');
  });

  it('warns to stderr and skips missing files without crashing', () => {
    const dir = makeTmpDir();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = loadRunbooks(dir, [{ path: 'missing.md' }]);
    expect(result).toBe('');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Runbook not found'));
    stderrSpy.mockRestore();
  });

  it('truncates output at 8 000 characters', () => {
    const dir = makeTmpDir();
    const longContent = 'x'.repeat(10_000);
    writeFileSync(join(dir, 'big.md'), longContent);
    const result = loadRunbooks(dir, [{ path: 'big.md' }]);
    expect(result.length).toBeLessThanOrEqual(8_000 + 200); // header overhead
    expect(result).toContain('[truncated]');
  });

  it('skips empty runbook files', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'empty.md'), '   \n  ');
    const result = loadRunbooks(dir, [{ path: 'empty.md' }]);
    expect(result).toBe('');
  });

  it('resolves paths relative to configDir', () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'nested.md'), 'Nested runbook content');
    const result = loadRunbooks(dir, [{ path: 'sub/nested.md' }]);
    expect(result).toContain('Nested runbook content');
  });
});
