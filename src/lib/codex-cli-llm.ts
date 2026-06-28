/**
 * External LLM integration via OpenAI Codex CLI (`codex -q`).
 *
 * Provides an alternative to the Flue/Anthropic API for one-shot LLM
 * inference. Requires the `codex` CLI to be installed and authenticated
 * (via `codex auth login` or OPENAI_API_KEY env var).
 *
 * This mode does NOT support tool use — the Flue agent (heimdall -p via
 * `flue connect`) is used for all cluster-diagnostic workflows that require
 * kubectl or other tools. Use this backend when the Flue/Anthropic stack is
 * unavailable but the Codex CLI is present and authenticated.
 */
import { makeCliLlm } from './cli-llm.ts';

export interface CodexCliOptions {
  /** Max execution time in milliseconds. Defaults to 120 000. */
  timeoutMs?: number;
  /** Model name, e.g. `o4-mini` or `gpt-4o`. */
  model?: string;
}

const { callCli, isCliAvailable } = makeCliLlm('codex', '-q');

/**
 * Invoke `codex -q <prompt>` and return the response text.
 *
 * Throws if the CLI is not installed, not authenticated, or exits non-zero.
 */
export const callCodexCli = (prompt: string, opts: CodexCliOptions = {}): Promise<string> =>
  callCli(prompt, opts);

/**
 * Return true if `codex` is on PATH and responds cleanly to `--version`.
 *
 * Non-throwing: availability does not guarantee authentication — a real call
 * may still fail if the CLI is not logged in.
 */
export const isCodexCliAvailable = (): Promise<boolean> => isCliAvailable();
