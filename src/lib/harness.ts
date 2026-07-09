/**
 * Read-only safety harness for Heimdall tools.
 *
 * Heimdall is an advisory agent: it must never mutate infrastructure.
 * BLOCKED_PREFIX is the single source of truth for the "blocked" response
 * format so callers (alert-mode, kubeconfig tool, etc.) can detect blocks by
 * importing this constant rather than hard-coding the string.
 *
 * The actual read-only enforcement lives per-tool: `kubectl-safety.ts`,
 * `aws-safety.ts`, `cdk-safety.ts`, and `trivy-safety.ts` each validate
 * commands against an allow-list before execution (see their `validateCommand`
 * equivalents), several sharing a common verdict via `subcommand-policy.ts`.
 */

/** Prefix prepended to every blocked tool response. */
export const BLOCKED_PREFIX = 'BLOCKED: ';
