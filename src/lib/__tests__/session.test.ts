import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('can create two sessions without collision', () => {
    const a = createSession({});
    const b = createSession({});
    expect(a.id).not.toBe(b.id);
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

  it('returns all created sessions sorted by createdAt', () => {
    const a = createSession({ name: 'first' });
    const b = createSession({ name: 'second' });
    const list = listSessions();
    expect(list).toHaveLength(2);
    // Must be sorted by createdAt ascending.
    const ids = list.map((s) => s.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
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
});
