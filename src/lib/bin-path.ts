import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve the absolute path to the heimdall binary relative to a src dir. */
export function resolveBinPath(srcDir: string): string {
  return resolve(srcDir, '..', 'bin', 'heimdall');
}

/**
 * Resolve the absolute path to the heimdall binary from a mode entry point's
 * own `import.meta.url` — the `dirname(fileURLToPath(...))` + `resolveBinPath`
 * pair repeated across every mode that only needs `__dirname` for this.
 */
export function resolveHeimdallBinPath(moduleUrl: string): string {
  return resolveBinPath(dirname(fileURLToPath(moduleUrl)));
}

/**
 * Build the environment for a Heimdall agent subprocess invocation:
 * `process.env`, with `HEIMDALL_MODEL` overridden when a model is given.
 * Shared by every mode that spawns the agent binary with a model override.
 */
export function buildAgentEnv(model?: string): NodeJS.ProcessEnv {
  return model ? { ...process.env, HEIMDALL_MODEL: model } : process.env;
}
