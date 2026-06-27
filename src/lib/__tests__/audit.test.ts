import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAudit, type AuditEntry } from '../audit.ts';

// Wrap appendFile and mkdir so individual tests can inject one-shot failures
// without affecting unrelated tests (which use the real implementation by default).
vi.mock('node:fs/promises', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs/promises')>();
  return { ...mod, appendFile: vi.fn(mod.appendFile), mkdir: vi.fn(mod.mkdir) };
});

const SAMPLE_ENTRY: AuditEntry = {
  ts: '2026-06-20T00:00:00.000Z',
  level: 'audit',
  cmd: 'kubectl get pods -n default',
  allowed: true,
  outcome: 'ok',
  durationMs: 42,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('writeAudit — disabled / null', () => {
  it('is a no-op when audit is null', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await writeAudit(SAMPLE_ENTRY, null);
    expect(spy).not.toHaveBeenCalled();
  });

  it('is a no-op when audit is undefined', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await writeAudit(SAMPLE_ENTRY, undefined);
    expect(spy).not.toHaveBeenCalled();
  });

  it('is a no-op when audit.enabled is false', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await writeAudit(SAMPLE_ENTRY, { enabled: false });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('writeAudit — stderr sink (no file)', () => {
  it('writes a valid JSON line to stderr', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });

    await writeAudit(SAMPLE_ENTRY, { enabled: true });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0].trimEnd());
    expect(entry.level).toBe('audit');
    expect(entry.cmd).toBe('kubectl get pods -n default');
    expect(entry.allowed).toBe(true);
    expect(entry.outcome).toBe('ok');
    expect(entry.durationMs).toBe(42);
    expect(entry.ts).toBe('2026-06-20T00:00:00.000Z');
  });

  it('writes blocked entry correctly', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });

    await writeAudit(
      { ts: 'now', level: 'audit', cmd: 'kubectl delete pod web', allowed: false, outcome: 'blocked' },
      { enabled: true },
    );

    const entry = JSON.parse(lines[0].trimEnd());
    expect(entry.allowed).toBe(false);
    expect(entry.outcome).toBe('blocked');
  });
});

describe('writeAudit — file sink (parent dir exists)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'heimdall-audit-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a JSON line to the configured file', async () => {
    const filePath = join(tmpDir, 'audit.jsonl');
    await writeAudit(SAMPLE_ENTRY, { enabled: true, file: filePath });

    const content = await readFile(filePath, 'utf8');
    const entry = JSON.parse(content.trimEnd());
    expect(entry.cmd).toBe('kubectl get pods -n default');
    expect(entry.level).toBe('audit');
  });

  it('appends multiple entries to the file', async () => {
    const filePath = join(tmpDir, 'audit.jsonl');
    await writeAudit(SAMPLE_ENTRY, { enabled: true, file: filePath });
    await writeAudit({ ...SAMPLE_ENTRY, cmd: 'kubectl describe pod web' }, { enabled: true, file: filePath });

    const content = await readFile(filePath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).cmd).toBe('kubectl describe pod web');
  });
});

describe('writeAudit — ENOENT path (parent dir does not exist)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'heimdall-audit-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates the parent directory and writes when it does not exist', async () => {
    const filePath = join(tmpDir, 'subdir', 'audit.jsonl');
    await writeAudit(SAMPLE_ENTRY, { enabled: true, file: filePath });

    const content = await readFile(filePath, 'utf8');
    const entry = JSON.parse(content.trimEnd());
    expect(entry.cmd).toBe('kubectl get pods -n default');
  });

  it('creates deeply-nested parent directories via recursive mkdir', async () => {
    const filePath = join(tmpDir, 'a', 'b', 'c', 'audit.jsonl');
    await writeAudit(SAMPLE_ENTRY, { enabled: true, file: filePath });

    const content = await readFile(filePath, 'utf8');
    expect(JSON.parse(content.trimEnd()).level).toBe('audit');
  });
});

describe('writeAudit — non-ENOENT file error falls back to stderr', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'heimdall-audit-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('falls back to stderr when the file path is invalid (ENOTDIR)', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });

    const blockingFile = join(tmpDir, 'not-a-dir');
    await writeFile(blockingFile, 'I am a file');
    const filePath = join(blockingFile, 'audit.jsonl');

    await expect(writeAudit(SAMPLE_ENTRY, { enabled: true, file: filePath })).resolves.toBeUndefined();
    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[0].trimEnd());
    expect(entry.cmd).toBe('kubectl get pods -n default');
  });
});

describe('writeAudit — mkdir succeeds but second appendFile fails: falls back to stderr', () => {
  it('writes to stderr when the second appendFile throws after mkdir succeeds', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    vi.mocked(fsPromises.appendFile)
      .mockRejectedValueOnce(enoent)
      .mockRejectedValueOnce(new Error('EPERM'));
    vi.mocked(fsPromises.mkdir).mockResolvedValueOnce(undefined as never);

    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });

    await writeAudit(SAMPLE_ENTRY, { enabled: true, file: '/fake/path/audit.jsonl' });

    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[0].trimEnd());
    expect(entry.cmd).toBe('kubectl get pods -n default');
  });
});
