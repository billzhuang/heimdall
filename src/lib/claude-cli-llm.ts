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
import { makeCliLlm, type CliLlmOptions } from './cli-llm.ts';

/** Options for `callClaudeCli`. `model` is the name without provider prefix, e.g. `claude-sonnet-4-6`. */
export type ClaudeCliOptions = CliLlmOptions;

const { callCli, isCliAvailable } = makeCliLlm('claude', '-p');

/**
 * Invoke `claude -p <prompt>` and return the response text.
 *
 * Throws if the CLI is not installed, not authenticated, or exits non-zero.
 */
export const callClaudeCli = (prompt: string, opts: ClaudeCliOptions = {}): Promise<string> =>
  callCli(prompt, opts);

/**
 * Return true if `claude` is on PATH and responds cleanly to `--version`.
 *
 * Non-throwing: availability does not guarantee authentication — a real call
 * may still fail if the CLI is not logged in.
 */
export const isClaudeCliAvailable = (): Promise<boolean> => isCliAvailable();
