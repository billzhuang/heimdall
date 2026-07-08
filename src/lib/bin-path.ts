import { resolve } from 'node:path';

/** Resolve the absolute path to the heimdall binary relative to a src dir. */
export function resolveBinPath(srcDir: string): string {
  return resolve(srcDir, '..', 'bin', 'heimdall');
}

/**
 * Build the environment for a Heimdall agent subprocess invocation:
 * `process.env`, with `HEIMDALL_MODEL` overridden when a model is given.
 * Shared by every mode that spawns the agent binary with a model override.
 */
export function buildAgentEnv(model?: string): NodeJS.ProcessEnv {
  return model ? { ...process.env, HEIMDALL_MODEL: model } : process.env;
}
