import { resolve } from 'node:path';

/** Resolve the absolute path to the heimdall binary relative to a src dir. */
export function resolveBinPath(srcDir: string): string {
  return resolve(srcDir, '..', 'bin', 'heimdall');
}
