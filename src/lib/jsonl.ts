import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { withMkdirRetry } from './fs-retry.ts';

/**
 * Resolve a configured file path against a base directory: an explicit
 * configured value wins (returned as-is if absolute, else resolved against
 * baseDir), otherwise falls back to defaultPath. Shared by baseline.ts and
 * task-history.ts, whose JSONL store paths both follow this "explicit config
 * wins, else package-relative default" shape.
 */
export function resolveConfiguredPath(
  configuredPath: string | null | undefined,
  baseDir: string,
  defaultPath: string,
): string {
  if (!configuredPath) return defaultPath;
  return isAbsolute(configuredPath) ? configuredPath : resolve(baseDir, configuredPath);
}

/** Generate a unique JSONL log entry id (`<unix-ms>-<12 hex chars>`) and ISO-8601 timestamp. */
export function generateEntryId(): { id: string; timestamp: string } {
  const now = new Date();
  return {
    id: `${now.getTime()}-${randomBytes(6).toString('hex')}`,
    timestamp: now.toISOString(),
  };
}

/** Append a single item as a JSONL line to a file (creates the file and parent dirs if absent). */
export async function appendJsonlLine<T>(item: T, filePath: string): Promise<void> {
  const serialized = JSON.stringify(item);
  if (serialized === undefined) {
    throw new TypeError(`appendJsonlLine: item is not JSON-serializable (got ${typeof item})`);
  }
  await withMkdirRetry(filePath, () => appendFile(filePath, serialized + '\n', 'utf8'));
}

/**
 * Overwrite a file with items serialized as JSONL (one JSON object per line).
 * Creates the parent directory when absent, identical to the appendJsonlLine pattern.
 */
export async function writeJsonlFile<T>(items: T[], filePath: string): Promise<void> {
  const content = items.map((item) => JSON.stringify(item)).join('\n') + (items.length > 0 ? '\n' : '');
  await withMkdirRetry(filePath, () => writeFile(filePath, content, 'utf8'));
}

/** Read all entries from a JSONL file. Returns [] when the file does not exist. */
export async function readJsonlFile<T>(
  filePath: string,
  onSkip?: (line: string) => void,
): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
  const entries: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as T);
    } catch {
      onSkip?.(trimmed);
    }
  }
  return entries;
}

/**
 * Synchronous counterpart to `readJsonlFile`, for use at module-load time
 * (e.g. building agent startup context) where an async read isn't practical.
 * Returns [] on ENOENT or any other read error; non-ENOENT errors are reported
 * via `onError` rather than thrown. Malformed or non-object lines are dropped
 * silently. When `tail` is set, only the last N non-empty lines are parsed.
 */
export function readJsonlFileSync<T>(
  filePath: string,
  opts?: { tail?: number; onError?: (err: unknown) => void },
): T[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') opts?.onError?.(err);
    return [];
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  const selected = opts?.tail === undefined ? lines : opts.tail === 0 ? [] : lines.slice(-opts.tail);
  return selected.flatMap((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return parsed !== null && typeof parsed === 'object' ? [parsed as T] : [];
    } catch {
      return [];
    }
  });
}
