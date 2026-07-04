/**
 * Shared spawn/buffer/timeout/close pipeline for CLI subprocess launchers.
 *
 * Extracted from eval-runner.ts's scenario runner and serve-mode.ts's
 * runAgentDiagnose, which each hand-rolled the same "spawn, collect
 * stdout/stderr, kill on timeout, settle once on close/error" wiring —
 * only the kill strategy and the timeout/exit error text differed per
 * call site, so those are left as caller-supplied callbacks.
 */
import { spawn } from 'node:child_process';

export interface SpawnAndCollectOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /**
   * Run the child as its own process group leader (`detached: true`) so a
   * timeout kill can reach its descendants too (e.g. a wrapped Flue agent).
   */
  detached?: boolean;
  /** Build the Error to reject with when timeoutMs elapses before the child exits. */
  onTimeout: () => Error;
  /**
   * Inspect the child's exit code/signal and collected (trimmed) output.
   * Return an Error to reject with, or null to resolve with `stdout`.
   */
  onExit: (code: number | null, signal: string | null, stdout: string, stderr: string) => Error | null;
}

/**
 * Spawn `binPath args`, buffer stdout/stderr, and resolve with trimmed
 * stdout on a clean exit (per `onExit`). Kills the child — via its process
 * group when `detached` is set, falling back to a direct kill — and rejects
 * with `onTimeout()` if it hasn't exited within `timeoutMs`.
 */
export function spawnAndCollect(
  binPath: string,
  args: string[],
  { env, timeoutMs, detached = false, onTimeout, onExit }: SpawnAndCollectOptions,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const child = spawn(binPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached });

    child.stdout?.on('data', (chunk: Buffer) => outChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => errChunks.push(chunk));

    const timer = setTimeout(() => {
      settle(() => {
        if (detached && child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            child.kill('SIGTERM');
          }
        } else {
          child.kill('SIGTERM');
        }
        reject(onTimeout());
      });
    }, timeoutMs);

    child.on('close', (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      settle(() => {
        const stdout = Buffer.concat(outChunks).toString('utf8').trim();
        const stderr = Buffer.concat(errChunks).toString('utf8').trim();
        const err = onExit(code, signal, stdout, stderr);
        if (err) reject(err); else resolve(stdout);
      });
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      settle(() => reject(err));
    });
  });
}
