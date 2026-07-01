/**
 * Interpret a Node `child_process` 'close' event (exit code + signal) as
 * either success or a descriptive Error, matching the phrasing duplicated
 * across the heimdall CLI's `*-mode.ts` subprocess launchers.
 */

/**
 * Returns an Error describing a non-zero exit or a signal-kill, or `null`
 * when the child exited cleanly (code 0, no signal).
 */
export function interpretChildExit(code: number | null, signal: string | null): Error | null {
  if (code !== null && code !== 0) return new Error(`heimdall exited with code ${code}`);
  if (code === null && signal !== null) return new Error(`heimdall killed by signal ${signal}`);
  return null;
}
