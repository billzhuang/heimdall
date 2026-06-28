/**
 * Tiny helpers for extracting messages from caught `unknown` values.
 *
 * TypeScript catch clauses type the bound variable as `unknown`, so every call
 * site that wants a string must write `err instanceof Error ? err.message :
 * String(err)`.  These helpers encode that idiom once and keep call sites brief.
 */

/** Return the message string of an Error, or String(err) for anything else. */
export function getMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Return the stack trace of an Error (falling back to message), or String(err)
 * for anything else.  Prefer this at the outermost catch boundary where a full
 * stack is useful for diagnostics.
 */
export function getStackOrMessage(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/**
 * Extract a human-readable detail string from an execFile / child_process
 * error (which may carry `stderr` and `stdout` alongside the standard
 * `message`).  Falls back through stderr → stdout → message → String.
 *
 * Pass `stdoutFirst: true` when stdout carries the primary error output
 * (e.g. Trivy, which writes structured JSON errors to stdout).
 */
export function getExecErrorDetail(error: unknown, stdoutFirst = false): string {
  if (error && typeof error === 'object') {
    const err = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
    const detail = stdoutFirst
      ? (err.stdout || err.stderr || err.message)
      : (err.stderr || err.stdout || err.message);
    if (detail) return String(detail).trim();
  }
  return String(error).trim();
}
