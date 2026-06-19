/**
 * External LLM integration via Claude Code CLI (`claude -p`).
 *
 * Provides an alternative to the Flue/Anthropic API for one-shot LLM
 * inference. Requires the `claude` CLI to be installed and authenticated
 * (via `claude auth login` or API-key-based auth).
 *
 * This mode does NOT support tool use — the Flue agent (heimdall -p via
 * `flue connect`) is used for all cluster-diagnostic workflows that require
 * kubectl or other tools. Use this backend when a raw ANTHROPIC_API_KEY is
 * unavailable but the Claude CLI is present and authenticated.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

export interface ClaudeCliOptions {
  /** Max execution time in milliseconds. Defaults to 120 000. */
  timeoutMs?: number;
  /** Model name (without provider prefix), e.g. `claude-sonnet-4-6`. */
  model?: string;
}

/**
 * Invoke `claude -p <prompt>` and return the response text.
 *
 * Throws if the CLI is not installed, not authenticated, or exits non-zero.
 */
export async function callClaudeCli(
  prompt: string,
  opts: ClaudeCliOptions = {},
): Promise<string> {
  const args: string[] = ['-p', prompt];
  if (opts.model) args.push('--model', opts.model);

  const { stdout } = await execFileAsync('claude', args, {
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
  });

  return stdout.trim();
}

/**
 * Return true if `claude` is on PATH and responds cleanly to `--version`.
 *
 * Non-throwing: availability does not guarantee authentication — a real call
 * may still fail if the CLI is not logged in.
 */
export async function isClaudeCliAvailable(): Promise<boolean> {
  try {
    await execFileAsync('claude', ['--version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
