import { appendFile, readFile } from 'node:fs/promises';

/** Append a single item as a JSONL line to a file (creates the file if absent). */
export async function appendJsonlLine<T>(item: T, filePath: string): Promise<void> {
  await appendFile(filePath, JSON.stringify(item) + '\n', 'utf8');
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
