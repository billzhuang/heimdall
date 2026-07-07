/**
 * Shared factory for external LLM CLI integrations (claude, codex, etc.).
 *
 * `makeCliLlm(cliName, promptFlag)` returns a call function and an availability
 * probe, both built on the same execFile invocation so the two CLI adapters
 * share a single implementation.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

export interface CliLlmOptions {
  /** Max execution time in milliseconds. Defaults to 120 000. */
  timeoutMs?: number;
  /** Model name passed via `--model`. */
  model?: string;
}

/** Builds the argv for a `callCli` invocation: `[promptFlag, prompt, --model, <model>?]`. */
export function buildCliArgs(promptFlag: string, prompt: string, opts: CliLlmOptions = {}): string[] {
  const args: string[] = [promptFlag, prompt];
  if (opts.model) args.push('--model', opts.model);
  return args;
}

/** Builds the `execFile` options for a `callCli` invocation. */
export function buildCliExecOptions(opts: CliLlmOptions = {}): { timeout: number; maxBuffer: number } {
  return {
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
  };
}

/**
 * Returns `{ callCli, isCliAvailable }` bound to the given binary and prompt flag.
 */
export function makeCliLlm(cliName: string, promptFlag: string): {
  callCli: (prompt: string, opts?: CliLlmOptions) => Promise<string>;
  isCliAvailable: () => Promise<boolean>;
} {
  async function callCli(prompt: string, opts: CliLlmOptions = {}): Promise<string> {
    const { stdout } = await execFileAsync(
      cliName,
      buildCliArgs(promptFlag, prompt, opts),
      buildCliExecOptions(opts),
    );

    return stdout.trim();
  }

  async function isCliAvailable(): Promise<boolean> {
    try {
      await execFileAsync(cliName, ['--version'], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  return { callCli, isCliAvailable };
}
