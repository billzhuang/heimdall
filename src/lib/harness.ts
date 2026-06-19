/**
 * Read-only safety harness for Heimdall tools.
 *
 * Heimdall is an advisory agent: it must never mutate infrastructure. This
 * module provides a composable safety layer that wraps tool execution with
 * pre-execution safety checks so every tool (kubectl, AWS CLI, Prometheus,
 * Helm, and future integrations such as Datadog or Amplitude) enforces
 * read-only access through a common interface.
 *
 * Design:
 *  - BLOCKED_PREFIX is the single source of truth for the "blocked" response
 *    format so callers (alert-mode, kubeconfig tool, etc.) can detect blocks
 *    by importing this constant rather than hard-coding the string.
 *  - withSafetyCheck wraps any execute function with ordered checks; the first
 *    failing check short-circuits and returns BLOCKED_PREFIX + reason.
 *  - createCheck adapts a simple "return a reason string or null" predicate
 *    into the HarnessCheckResult shape.
 *
 * Usage for a new tool:
 *
 *   const safeFetch = withSafetyCheck(
 *     async ({ query }) => callDatadogApi(query),
 *     createCheck(({ query }) =>
 *       isMutatingQuery(query) ? 'Mutating Datadog queries are not allowed.' : null,
 *     ),
 *   );
 */

/** Prefix prepended to every blocked tool response. */
export const BLOCKED_PREFIX = 'BLOCKED: ';

/** Result of a harness safety check. */
export interface HarnessCheckResult {
  allowed: boolean;
  /** Human-readable explanation — always present. Included in BLOCKED responses. */
  reason: string;
}

/**
 * A pure function that validates tool input against a read-only policy.
 * Returns `{ allowed: true }` to permit execution, or `{ allowed: false, reason }` to block.
 */
export type SafetyCheck<TInput extends Record<string, unknown> = Record<string, unknown>> = (
  input: TInput,
) => HarnessCheckResult;

/**
 * Wrap a tool execute function with one or more safety checks.
 *
 * Checks run in order; the first failure short-circuits execution and returns
 * `BLOCKED_PREFIX + reason`. The underlying executor is called only when all
 * checks pass. Passing no checks creates an unrestricted executor (useful for
 * inherently read-only tools like Prometheus queries).
 *
 * This is the canonical enforcement point for Heimdall's read-only guarantee.
 * New tools add a check function rather than embedding policy logic inside their
 * execute implementation, keeping policy and I/O concerns separate.
 */
export function withSafetyCheck<TInput extends Record<string, unknown>>(
  execute: (input: TInput) => Promise<string>,
  ...checks: ReadonlyArray<SafetyCheck<TInput>>
): (input: TInput) => Promise<string> {
  return async (input: TInput): Promise<string> => {
    for (const check of checks) {
      const result = check(input);
      if (!result.allowed) {
        return `${BLOCKED_PREFIX}${result.reason}`;
      }
    }
    return execute(input);
  };
}

/**
 * Build a SafetyCheck from a simple predicate function.
 *
 * The predicate receives the tool input and returns either:
 *  - `null`  → allowed (check passes)
 *  - a non-null string → the block reason (check fails)
 *
 * @example
 *   createCheck(({ action }) =>
 *     action === 'write' ? 'Write actions are not permitted.' : null,
 *   )
 */
export function createCheck<TInput extends Record<string, unknown>>(
  predicate: (input: TInput) => string | null,
): SafetyCheck<TInput> {
  return (input: TInput): HarnessCheckResult => {
    const reason = predicate(input);
    return reason !== null
      ? { allowed: false, reason }
      : { allowed: true, reason: 'check passed' };
  };
}
