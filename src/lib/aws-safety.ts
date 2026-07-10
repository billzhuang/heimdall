/**
 * Read-only safety policy for AWS CLI commands.
 *
 * Heimdall is an advisory SRE agent: it must never mutate infrastructure. This
 * module is the single source of truth for which AWS CLI subcommands are allowed.
 * It is pure (no I/O) so it can be unit- and property-tested, and is enforced
 * inside the `aws_cli` tool before any command is executed.
 *
 * Policy: default-deny. Commands whose subcommand starts with an explicitly
 * allowed read-only pattern (describe-, get-, list-, show-) are permitted.
 * Everything else is blocked, with an additional explicit block list for the
 * most commonly misused destructive operations to provide clearer error messages.
 */
import { findNextNonOptionToken, tokenizeShellArgs, type CommandValidationResult } from './tokenizer.ts';
import { classifySubcommand } from './subcommand-policy.ts';

/**
 * AWS CLI subcommand prefixes (and exact names) that indicate state mutation or
 * resource creation. These are always blocked.
 */
export const DESTRUCTIVE_AWS_PATTERNS = [
  'create-',
  'delete-',
  'terminate-',
  'put-',
  'update-',
  'attach-',
  'detach-',
  'modify-',
  'start-',
  'stop-',
  'reboot-',
  'run-instances',
  'allocate-',
  'associate-',
  'disassociate-',
  'release-',
  'revoke-',
  'authorize-',
] as const;

/**
 * AWS CLI subcommand prefixes that indicate read-only operations.
 * Commands must start with one of these to be allowed (default-deny).
 */
export const ALLOWED_AWS_PATTERNS = [
  'describe-',
  'get-',
  'list-',
  'show-',
] as const;

/** Result of parsing an AWS CLI command string. */
export interface ParsedAwsCommand {
  isAws: boolean;
  service: string | null;
  subcommand: string | null;
  args: string[];
  rawCommand: string;
}

/** Result of validating an AWS CLI command against the read-only policy. */
export type AwsCommandValidationResult = CommandValidationResult;

/**
 * AWS CLI global options that consume the following token as their value.
 * Must cover every value-taking global flag to prevent bypass attacks like
 * `aws --region us-east-1 delete-cluster`.
 */
export const AWS_OPTIONS_WITH_VALUE = new Set([
  '--region',
  '--profile',
  '--output',
  '--endpoint-url',
  '--color',
  '--cli-connect-timeout',
  '--cli-read-timeout',
  '--query',
  '--ca-bundle',
  // Note: --no-paginate / --no-sign-request / --debug are boolean flags (no value token).
  // Do NOT add them here — doing so would cause the parser to skip the token that follows
  // (e.g. `aws --no-paginate ec2 terminate-instances` would have `ec2` skipped and
  // `terminate-instances` treated as the service name, bypassing the destructive block).
]);

/**
 * Parse an AWS CLI command string to extract the service and subcommand.
 * Handles global flags that take a value (e.g. `aws --region us-east-1 ec2 describe-instances`)
 * so that an attacker cannot smuggle a destructive subcommand past the parser.
 *
 * Uses quote-aware tokenization (not a naive whitespace split) so that a
 * multi-word flag value rebuilt with quotes by `buildShellCommand` (e.g.
 * `--query 'x ec2 y'`) is parsed back as the single token it actually is at
 * execution time — a naive split would re-fragment it into bare words, one
 * of which could land on the service/subcommand slot and validate a
 * different (and potentially destructive) command than the one that
 * actually runs.
 */
export function parseAwsCommand(command: string): ParsedAwsCommand {
  const trimmed = command.trim();
  const result: ParsedAwsCommand = {
    isAws: false,
    service: null,
    subcommand: null,
    args: [],
    rawCommand: trimmed,
  };

  if (!trimmed) return result;

  const parts = tokenizeShellArgs(trimmed);
  if (parts[0].toLowerCase() !== 'aws') return result;
  result.isAws = true;

  const serviceIndex = findNextNonOptionToken(parts, 1, AWS_OPTIONS_WITH_VALUE);
  if (serviceIndex === -1) return result;
  result.service = parts[serviceIndex].toLowerCase();

  const subIndex = findNextNonOptionToken(parts, serviceIndex + 1, AWS_OPTIONS_WITH_VALUE);
  if (subIndex !== -1) {
    result.subcommand = parts[subIndex].toLowerCase();
    result.args = parts.slice(subIndex + 1);
  }

  return result;
}

/**
 * Validate an AWS CLI command against the read-only policy.
 * Returns null when the command is not an AWS CLI invocation (not in scope).
 */
export function validateAwsCommand(command: string): AwsCommandValidationResult | null {
  const parsed = parseAwsCommand(command);
  if (!parsed.isAws) return null;

  if (!parsed.service || !parsed.subcommand) {
    // Bare `aws` or `aws <service>` prints help — harmless.
    return {
      allowed: true,
      reason: 'AWS CLI without complete command',
      command: parsed.rawCommand,
      subcommand: null,
    };
  }

  const sub = parsed.subcommand;
  const fullSub = `${parsed.service} ${sub}`;

  const verdict = classifySubcommand(
    DESTRUCTIVE_AWS_PATTERNS.some((pattern) => sub.startsWith(pattern)),
    ALLOWED_AWS_PATTERNS.some((pattern) => sub.startsWith(pattern)),
  );

  if (verdict === 'destructive') {
    return {
      allowed: false,
      reason: `Destructive AWS command '${fullSub}' is blocked. Heimdall is read-only — suggest this command to the user to run manually instead.`,
      command: parsed.rawCommand,
      subcommand: fullSub,
    };
  }

  if (verdict === 'allowed') {
    return {
      allowed: true,
      reason: `Read-only AWS command '${fullSub}' is allowed`,
      command: parsed.rawCommand,
      subcommand: fullSub,
    };
  }

  return {
    allowed: false,
    reason: `Unknown AWS subcommand '${fullSub}' is blocked. Only read-only operations (describe-*, get-*, list-*, show-*) are permitted.`,
    command: parsed.rawCommand,
    subcommand: fullSub,
  };
}
