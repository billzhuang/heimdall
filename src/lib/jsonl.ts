import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

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
  try {
    await appendFile(filePath, serialized + '\n', 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, serialized + '\n', 'utf8');
    } else {
      throw err;
    }
  }
}

/**
 * Overwrite a file with items serialized as JSONL (one JSON object per line).
 * Creates the parent directory when absent, identical to the appendJsonlLine pattern.
 */
export async function writeJsonlFile<T>(items: T[], filePath: string): Promise<void> {
  const content = items.map((item) => JSON.stringify(item)).join('\n') + (items.length > 0 ? '\n' : '');
  try {
    await writeFile(filePath, content, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, 'utf8');
    } else {
      throw err;
    }
  }
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
