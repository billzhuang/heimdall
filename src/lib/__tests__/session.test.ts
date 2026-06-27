import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSession,
  deleteSession,
  listSessions,
  loadSession,
  sessionDir,
  updateSession,
} from '../session.ts';

// Redirect session files to a temp directory for each test.
let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'heimdall-session-test-'));
  process.env['HEIMDALL_SESSION_DIR'] = tmpDir;
});
afterEach(() => {
  delete process.env['HEIMDALL_SESSION_DIR'];
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('sessionDir', () => {
  it('returns HEIMDALL_SESSION_DIR when set', () => {
    expect(sessionDir()).toBe(tmpDir);
  });

  it('falls back to ~/.heimdall/sessions when env is unset', () => {
    delete process.env['HEIMDALL_SESSION_DIR'];
    expect(sessionDir()).toMatch(/\.heimdall[/\\]sessions$/);
    process.env['HEIMDALL_SESSION_DIR'] = tmpDir; // restore
  });

  it('falls back to default path when HEIMDALL_SESSION_DIR is an empty string', () => {
    process.env['HEIMDALL_SESSION_DIR'] = '';
    const dir = sessionDir();
    process.env['HEIMDALL_SESSION_DIR'] = tmpDir; // restore
    expect(dir).toMatch(/\.heimdall[/\\]sessions$/);
  });
});

describe('createSession', () => {
  it('returns a record with a unique id and default server URL', () => {
    const s = createSession({});
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.serverUrl).toBe('http://localhost:3583');
    expect(s.lastPromptAt).toBeNull();
    expect(s.createdAt).toBeTruthy();
  });

  it('persists custom name and serverUrl', () => {
    const s = createSession({ name: 'incident-42', serverUrl: 'http://myserver:4000' });
    expect(s.name).toBe('incident-42');
    expect(s.serverUrl).toBe('http://myserver:4000');
  });

  it('uses the default server URL when an empty string is supplied', () => {
    const s = createSession({ serverUrl: '' });
    expect(s.serverUrl).toBe('http://localhost:3583');
  });

  it('can create two sessions without collision', () => {
    const a = createSession({});
    const b = createSession({});
    expect(a.id).not.toBe(b.id);
  });

  it('creates the session directory when it does not yet exist', () => {
    const newDir = join(tmpDir, 'nested', 'sessions');
    process.env['HEIMDALL_SESSION_DIR'] = newDir;
    const s = createSession({});
    const loaded = loadSession(s.id);
    expect(loaded.id).toBe(s.id);
    process.env['HEIMDALL_SESSION_DIR'] = tmpDir;
  });

  it('writes a JSON file that loadSession can read back', () => {
    const s = createSession({ name: 'roundtrip' });
    const loaded = loadSession(s.id);
    expect(loaded).toEqual(s);
  });
});

describe('loadSession', () => {
  it('throws when the session does not exist', () => {
    expect(() => loadSession('nonexistent-id-xyz')).toThrow(/not found/i);
  });

  it('returns the correct record for a known session', () => {
    const s = createSession({ name: 'lookup' });
    const loaded = loadSession(s.id);
    expect(loaded.id).toBe(s.id);
    expect(loaded.name).toBe('lookup');
  });

  it('throws for a file with valid JSON but invalid SessionRecord structure', () => {
    const record = createSession({});
    const [file] = readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    writeFileSync(join(tmpDir, file!), '{"foo":"bar"}', 'utf-8');
    expect(() => loadSession(record.id)).toThrow(/Invalid session record structure/);
  });

  it('throws "Failed to parse session" when file contains unparseable content', () => {
    const record = createSession({});
    const [file] = readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    writeFileSync(join(tmpDir, file!), 'not valid json }{', 'utf-8');
    expect(() => loadSession(record.id)).toThrow(/Failed to parse session/);
  });

  it('throws for a session record where name is a non-string type', () => {
    const record = createSession({});
    const [file] = readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    const corrupt = { id: record.id, serverUrl: 'http://x', createdAt: record.createdAt, lastPromptAt: null, name: 42 };
    writeFileSync(join(tmpDir, file!), JSON.stringify(corrupt), 'utf-8');
    expect(() => loadSession(record.id)).toThrow(/Invalid session record structure/);
  });
});

describe('updateSession', () => {
  it('persists changes to lastPromptAt', () => {
    const s = createSession({});
    expect(s.lastPromptAt).toBeNull();

    s.lastPromptAt = '2026-06-24T12:00:00.000Z';
    updateSession(s);

    const reloaded = loadSession(s.id);
    expect(reloaded.lastPromptAt).toBe('2026-06-24T12:00:00.000Z');
  });

  it('persists name changes', () => {
    const s = createSession({ name: 'old-name' });
    s.name = 'new-name';
    updateSession(s);
    expect(loadSession(s.id).name).toBe('new-name');
  });
});

describe('deleteSession', () => {
  it('removes the session file', () => {
    const s = createSession({});
    deleteSession(s.id);
    expect(() => loadSession(s.id)).toThrow(/not found/i);
  });

  it('throws when the session does not exist', () => {
    expect(() => deleteSession('ghost-id-xyz')).toThrow(/not found/i);
  });
});

describe('listSessions', () => {
  it('returns empty array when no sessions exist', () => {
    expect(listSessions()).toEqual([]);
  });

  it('returns all created sessions sorted by createdAt ascending', () => {
    const a = createSession({ name: 'first' });
    const b = createSession({ name: 'second' });
    const list = listSessions();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.id)).toContain(a.id);
    expect(list.map((s) => s.id)).toContain(b.id);
    // Verify the sort invariant: each element's createdAt <= the next.
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1]!.createdAt.localeCompare(list[i]!.createdAt)).toBeLessThanOrEqual(0);
    }
  });

  it('excludes deleted sessions', () => {
    const a = createSession({});
    const b = createSession({});
    deleteSession(a.id);
    const list = listSessions();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(b.id);
  });

  it('silently skips corrupt JSON files', () => {
    createSession({});
    // Write a corrupt file directly.
    writeFileSync(join(tmpDir, 'corrupt.json'), 'not-json', 'utf-8');
    expect(() => listSessions()).not.toThrow();
    expect(listSessions()).toHaveLength(1);
  });

  it('silently skips structurally invalid (but parseable) JSON files', () => {
    createSession({});
    writeFileSync(join(tmpDir, 'wrong-shape.json'), '{"unexpected":"fields"}', 'utf-8');
    expect(listSessions()).toHaveLength(1);
  });

  it('returns empty array when the session directory does not exist', () => {
    process.env['HEIMDALL_SESSION_DIR'] = join(tmpDir, 'nonexistent');
    expect(listSessions()).toEqual([]);
    process.env['HEIMDALL_SESSION_DIR'] = tmpDir; // restore
  });
});

// ---------------------------------------------------------------------------
// Non-ENOENT error rethrow paths (use real fs conditions to avoid ESM mock limits)
// ---------------------------------------------------------------------------

describe('loadSession — non-ENOENT read failure', () => {
  it('rethrows EISDIR when the session file path is a directory', () => {
    const s = createSession({});
    // Replace the session file with a directory so readFileSync throws EISDIR.
    const [file] = readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    rmSync(join(tmpDir, file!));
    mkdirSync(join(tmpDir, file!));
    expect(() => loadSession(s.id)).toThrow();
  });
});

describe('deleteSession — non-ENOENT unlink failure', () => {
  it('rethrows EISDIR when the session file path is a directory', () => {
    const s = createSession({});
    // Replace the session file with a directory so unlinkSync throws EISDIR.
    const [file] = readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    rmSync(join(tmpDir, file!));
    mkdirSync(join(tmpDir, file!));
    expect(() => deleteSession(s.id)).toThrow();
  });
});

describe('listSessions — non-ENOENT readdirSync failure', () => {
  it('rethrows ENOTDIR when the session directory path is a file', () => {
    // Point HEIMDALL_SESSION_DIR at a regular file so readdirSync throws ENOTDIR.
    const fileAsDir = join(tmpDir, 'not-a-directory');
    writeFileSync(fileAsDir, 'content');
    process.env['HEIMDALL_SESSION_DIR'] = fileAsDir;
    expect(() => listSessions()).toThrow();
    process.env['HEIMDALL_SESSION_DIR'] = tmpDir;
  });
});
