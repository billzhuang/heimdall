import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Run `op()` and, on ENOENT, create the parent directory and retry once.
 * Non-ENOENT errors (from either attempt) are re-thrown immediately.
 */
export async function withMkdirRetry<T>(filePath: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      await mkdir(dirname(filePath), { recursive: true });
      return await op();
    }
    throw err;
  }
}
