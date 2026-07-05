/**
 * Shared spawn/buffer/timeout/close pipeline for CLI subprocess launchers.
 *
 * Extracted from eval-runner.ts's scenario runner and serve-mode.ts's
 * runAgentDiagnose, which each hand-rolled the same "spawn, collect
 * stdout/stderr, kill on timeout, settle once on close/error" wiring —
 * only the kill strategy and the timeout/exit error text differed per
 * call site, so those are left as caller-supplied callbacks.
 */
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Kill a spawned child, preferring its process group (so a timeout kill
 * reaches detached descendants too) and falling back to a direct kill when
 * the process-group kill isn't available or throws (e.g. already exited).
 */
function killChild(child: ChildProcess, detached: boolean, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (detached && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // fall through to a direct kill
    }
  }
  child.kill(signal);
}

export interface SpawnAndCollectOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /**
   * Run the child as its own process group leader (`detached: true`) so a
   * timeout kill can reach its descendants too (e.g. a wrapped Flue agent).
   */
  detached?: boolean;
  /**
   * Child stdio mode. `'pipe'` (default) buffers stdout/stderr and passes them
   * to `onExit`/resolves with stdout. `'inherit'` streams the child's stdout
   * and stderr directly to the parent's — for callers that want the agent's
   * output visible live and don't need it as a string — and always passes
   * empty strings to `onExit`/resolves with `''`. `'tee'` streams stdout to the
   * parent's stdout live while also buffering it for `onExit`/the resolved
   * string (for callers that want to show progress and still parse the
   * result); stderr is inherited directly and never captured.
   */
  stdio?: 'pipe' | 'inherit' | 'tee';
  /** Build the Error to reject with when timeoutMs elapses before the child exits. */
  onTimeout: () => Error;
  /**
   * Abort signal for cancelling an in-flight spawn (e.g. process shutdown).
   * When already aborted, rejects with `onAbort()` without spawning.
   * When it fires mid-run, kills the child and rejects with `onAbort()`.
   */
  signal?: AbortSignal;
  /** Build the Error to reject with when `signal` aborts. Required whenever `signal` is passed. */
  onAbort?: () => Error;
  /**
   * When set, escalates to SIGKILL if the child hasn't exited this many ms
   * after the initial SIGTERM (from a timeout or an abort).
   */
  killGraceMs?: number;
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
 * with `onTimeout()` if it hasn't exited within `timeoutMs`, or with
 * `onAbort()` if `signal` aborts first. When `killGraceMs` is set, escalates
 * to SIGKILL if the child ignores the initial SIGTERM for that long.
 */
export function spawnAndCollect(
  binPath: string,
  args: string[],
  { env, timeoutMs, detached = false, stdio = 'pipe', signal, onAbort, killGraceMs, onTimeout, onExit }: SpawnAndCollectOptions,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(onAbort ? onAbort() : new Error('Aborted'));
      return;
    }

    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const child = spawn(binPath, args, {
      env,
      stdio:
        stdio === 'inherit' ? ['ignore', 'inherit', 'inherit'] : stdio === 'tee' ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'pipe', 'pipe'],
      detached,
    });

    if (stdio === 'pipe' || stdio === 'tee') {
      child.stdout?.on('data', (chunk: Buffer) => {
        outChunks.push(chunk);
        if (stdio === 'tee') process.stdout.write(chunk);
      });
    }
    if (stdio === 'pipe') {
      child.stderr?.on('data', (chunk: Buffer) => errChunks.push(chunk));
    }

    let killGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const killWithGrace = () => {
      killChild(child, detached);
      if (killGraceMs !== undefined) {
        killGraceTimer = setTimeout(() => killChild(child, detached, 'SIGKILL'), killGraceMs);
      }
    };

    const timer = setTimeout(() => {
      settle(() => {
        killWithGrace();
        reject(onTimeout());
      });
    }, timeoutMs);

    const onSignalAbort = () => {
      settle(() => {
        clearTimeout(timer);
        killWithGrace();
        reject(onAbort ? onAbort() : new Error('Aborted'));
      });
    };
    if (signal) signal.addEventListener('abort', onSignalAbort, { once: true });

    child.on('close', (code: number | null, childSignal: string | null) => {
      clearTimeout(timer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      if (signal) signal.removeEventListener('abort', onSignalAbort);
      settle(() => {
        const stdout = Buffer.concat(outChunks).toString('utf8').trim();
        const stderr = Buffer.concat(errChunks).toString('utf8').trim();
        const err = onExit(code, childSignal, stdout, stderr);
        if (err) reject(err); else resolve(stdout);
      });
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      if (signal) signal.removeEventListener('abort', onSignalAbort);
      settle(() => reject(err));
    });
  });
}
