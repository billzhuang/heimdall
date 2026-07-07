/**
 * Shared three-way verdict for a read-only CLI safety policy's default-deny
 * decision tree (destructive block-list wins, then the read-only allow-list,
 * then default-deny). `aws-safety.ts` and `cdk-safety.ts` both walk this exact
 * shape over their own subcommand matchers; only the matcher (prefix vs. exact
 * match) and the resulting message text differ per CLI, so those stay in each
 * call site.
 */
export type SubcommandVerdict = 'destructive' | 'allowed' | 'unknown';

/** Classify a subcommand given whether it matched the destructive/allowed sets. Destructive takes precedence. */
export function classifySubcommand(isDestructive: boolean, isAllowed: boolean): SubcommandVerdict {
  if (isDestructive) return 'destructive';
  if (isAllowed) return 'allowed';
  return 'unknown';
}
