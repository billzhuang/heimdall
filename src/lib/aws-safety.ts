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
export interface AwsCommandValidationResult {
  allowed: boolean;
  reason: string;
  command: string;
  subcommand: string | null;
}

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
  '--no-paginate',    // flag-only (no value), but harmless to include
]);

/**
 * Parse an AWS CLI command string to extract the service and subcommand.
 * Handles global flags that take a value (e.g. `aws --region us-east-1 ec2 describe-instances`)
 * so that an attacker cannot smuggle a destructive subcommand past the parser.
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

  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return result;

  if (parts[0].toLowerCase() !== 'aws') return result;
  result.isAws = true;

  // Find service: first non-option token after 'aws'
  let skipNext = false;
  let serviceIndex = -1;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];

    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (part.startsWith('-')) {
      if (!part.includes('=') && AWS_OPTIONS_WITH_VALUE.has(part)) {
        skipNext = true;
      }
      continue;
    }

    result.service = part.toLowerCase();
    serviceIndex = i;
    break;
  }

  if (serviceIndex === -1) return result;

  // Find subcommand: first non-option token after service
  skipNext = false;
  for (let i = serviceIndex + 1; i < parts.length; i++) {
    const part = parts[i];

    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (part.startsWith('-')) {
      if (!part.includes('=') && AWS_OPTIONS_WITH_VALUE.has(part)) {
        skipNext = true;
      }
      continue;
    }

    result.subcommand = part.toLowerCase();
    result.args = parts.slice(i + 1);
    break;
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

  // Explicitly block known destructive patterns for a clear error message.
  const isDestructive = DESTRUCTIVE_AWS_PATTERNS.some((pattern) => sub.startsWith(pattern));
  if (isDestructive) {
    return {
      allowed: false,
      reason: `Destructive AWS command '${fullSub}' is blocked. Heimdall is read-only — suggest this command to the user to run manually instead.`,
      command: parsed.rawCommand,
      subcommand: fullSub,
    };
  }

  // Default-deny: only allow explicitly permitted read-only patterns.
  const isAllowed = ALLOWED_AWS_PATTERNS.some((pattern) => sub.startsWith(pattern));
  if (isAllowed) {
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
