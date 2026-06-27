import { readFile } from 'node:fs/promises';

/** Read all entries from a JSONL file. Returns [] when the file does not exist. */
export async function readJsonlFile<T>(
  filePath: string,
  onSkip?: (line: string) => void,
): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
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
