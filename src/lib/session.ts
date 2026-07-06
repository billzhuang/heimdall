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
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
  // Use || so an empty-string env var falls back to the default.
  return (
    process.env['HEIMDALL_SESSION_DIR'] ||
    join(homedir(), '.heimdall', 'sessions')
  );
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Translate ENOENT into a "Session not found" error; rethrow everything else. */
function rethrowOrNotFound(err: unknown, id: string): never {
  if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error(`Session not found: ${id}`);
  }
  throw err;
}

function sessionPath(dir: string, id: string): string {
  // Sanitise id so a crafted id can't escape the directory.
  const safe = createHash('sha256').update(id).digest('hex');
  return join(dir, `${safe}.json`);
}

function writeSessionRecord(dir: string, record: SessionRecord): void {
  writeFileSync(sessionPath(dir, record.id), JSON.stringify(record, null, 2), 'utf-8');
}

/** Type guard for the on-disk SessionRecord shape. Exported for direct unit testing. */
export function isValidSessionRecord(parsed: unknown): parsed is SessionRecord {
  if (!parsed || typeof parsed !== 'object') return false;
  const rec = parsed as Record<string, unknown>;
  return (
    typeof rec['id'] === 'string' &&
    typeof rec['createdAt'] === 'string' &&
    typeof rec['serverUrl'] === 'string' &&
    (rec['lastPromptAt'] === null || typeof rec['lastPromptAt'] === 'string') &&
    (rec['name'] === undefined || typeof rec['name'] === 'string')
  );
}

function parseSessionRecord(raw: string, context: string): SessionRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse session ${context}: ${(err as Error).message}`);
  }
  if (!isValidSessionRecord(parsed)) {
    throw new Error(`Invalid session record structure for ${context}`);
  }
  return parsed;
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
    // Use || so an empty-string serverUrl falls back to the default.
    serverUrl: opts.serverUrl || 'http://localhost:3583',
    createdAt: new Date().toISOString(),
    lastPromptAt: null,
  };
  writeSessionRecord(dir, record);
  return record;
}

export function loadSession(id: string): SessionRecord {
  const dir = sessionDir();
  const file = sessionPath(dir, id);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err) {
    rethrowOrNotFound(err, id);
  }
  return parseSessionRecord(raw, id);
}

export function updateSession(record: SessionRecord): void {
  // The session directory must already exist if the record was loaded from it.
  // Write directly; no need for ensureDir on every update.
  writeSessionRecord(sessionDir(), record);
}

export function deleteSession(id: string): void {
  const dir = sessionDir();
  const file = sessionPath(dir, id);
  try {
    unlinkSync(file);
  } catch (err) {
    rethrowOrNotFound(err, id);
  }
}

export function listSessions(): SessionRecord[] {
  const dir = sessionDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        return [parseSessionRecord(readFileSync(join(dir, f), 'utf-8'), f)];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
