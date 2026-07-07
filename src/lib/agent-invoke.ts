/**
 * Shared "run the agent subprocess and parse its JSON output" step used by
 * both HTTP entry points that invoke Heimdall as a one-shot diagnosis
 * (serve-mode's POST /api/diagnose and agentcore-handler's POST /invocations).
 * The two callers differ only in how they build their success response.
 */
import type { OneShotFinding } from './format-output.ts';
import { getMessage } from './error-utils.ts';
import { isPlainObject } from './json-utils.ts';

export type AgentInvocationResult =
  | { ok: true; finding: OneShotFinding | null; trimmed: string }
  | { ok: false; status: 500; error: string };

/**
 * Run `agentFn(prompt, model)`, trim its output, and parse it as JSON.
 * Returns a 500 result when the agent throws or produces blank output.
 */
export async function invokeAgentForFinding(
  agentFn: (prompt: string, model: string) => Promise<string>,
  prompt: string,
  model: string,
): Promise<AgentInvocationResult> {
  try {
    const raw = await agentFn(prompt, model);
    const trimmed = raw.trim();
    if (!trimmed) {
      return { ok: false, status: 500, error: 'Agent produced no output' };
    }
    const parsed: unknown = JSON.parse(trimmed);
    const finding = isPlainObject(parsed) ? (parsed as unknown as OneShotFinding) : null;
    return { ok: true, finding, trimmed };
  } catch (err) {
    return { ok: false, status: 500, error: `Agent error: ${getMessage(err)}` };
  }
}
