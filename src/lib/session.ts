/**
 * Session management helpers for Heimdall's durable multi-turn mode.
 *
 * Sessions are lightweight JSON files stored in ~/.heimdall/sessions/ (or the
 * path set by HEIMDALL_SESSION_DIR).  They hold only the session handle
 * (id + server URL) — the actual conversation state is kept by Flue's durable
 * streams on the server side, keyed by the agent instance id.
 *
 * Session lifecycle:
 *   createSession()   – generate an id, write the handle file, return the record
 *   loadSession(id)   – read and parse a handle file
 *   listSessions()    – return all valid handle files
 *   updateSession()   – overwrite an existing handle file (e.g. lastPromptAt)
 *   deleteSession(id) – remove the handle file
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SessionRecord {
  /** UUID that doubles as the Flue agent instance id. */
  id: string;
  /** Human-readable label (optional). */
  name?: string;
  /** Base URL of the running Flue server. */
  serverUrl: string;
  createdAt: string;
  lastPromptAt: string | null;
}

/** Returns the directory where session handle files are stored. */
export function sessionDir(): string {
  return (
    process.env['HEIMDALL_SESSION_DIR'] ??
    join(homedir(), '.heimdall', 'sessions')
  );
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function sessionPath(dir: string, id: string): string {
  // Sanitise id so a crafted id can't escape the directory.
  const safe = createHash('sha256').update(id).digest('hex');
  return join(dir, `${safe}.json`);
}

export function createSession(opts: {
  name?: string;
  serverUrl?: string;
}): SessionRecord {
  const dir = sessionDir();
  ensureDir(dir);
  const record: SessionRecord = {
    id: randomUUID(),
    name: opts.name,
    serverUrl: opts.serverUrl ?? 'http://localhost:3000',
    createdAt: new Date().toISOString(),
    lastPromptAt: null,
  };
  writeFileSync(sessionPath(dir, record.id), JSON.stringify(record, null, 2), 'utf-8');
  return record;
}

export function loadSession(id: string): SessionRecord {
  const dir = sessionDir();
  const file = sessionPath(dir, id);
  if (!existsSync(file)) {
    throw new Error(`Session not found: ${id}`);
  }
  const raw = readFileSync(file, 'utf-8');
  return JSON.parse(raw) as SessionRecord;
}

export function updateSession(record: SessionRecord): void {
  const dir = sessionDir();
  ensureDir(dir);
  writeFileSync(sessionPath(dir, record.id), JSON.stringify(record, null, 2), 'utf-8');
}

export function deleteSession(id: string): void {
  const dir = sessionDir();
  const file = sessionPath(dir, id);
  if (!existsSync(file)) {
    throw new Error(`Session not found: ${id}`);
  }
  unlinkSync(file);
}

export function listSessions(): SessionRecord[] {
  const dir = sessionDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(dir, f), 'utf-8')) as SessionRecord];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
