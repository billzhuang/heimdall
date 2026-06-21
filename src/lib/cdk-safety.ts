/**
 * Read-only safety policy for CDK CLI commands.
 *
 * Heimdall is an advisory SRE agent: it must never mutate infrastructure. This
 * module is the single source of truth for which CDK CLI subcommands are allowed.
 * It is pure (no I/O) so it can be unit- and property-tested, and is enforced
 * inside the `cdk_query` tool before any command is executed.
 *
 * Policy: default-deny. Only explicitly listed read-only subcommands are allowed.
 * Mutating subcommands (deploy, destroy, bootstrap, watch, import, migrate, gc,
 * rollback) are always blocked with a clear error message.
 */

/**
 * CDK CLI subcommands that mutate infrastructure or environment state.
 * These are always blocked.
 */
export const DESTRUCTIVE_CDK_COMMANDS = [
  'deploy',
  'destroy',
  'bootstrap',
  'watch',
  'import',
  'migrate',
  'gc',
  'rollback',
  'acknowledge',
  'ack',
] as const;

/**
 * CDK CLI subcommands that are read-only / informational.
 * Only these are allowed (default-deny).
 */
export const ALLOWED_CDK_COMMANDS = [
  'ls',
  'list',
  'synth',
  'synthesize',
  'diff',
  'metadata',
  'context',
  'notices',
  'docs',
  'doc',
  'version',
  'doctor',
  'drift',
] as const;

/** Result of parsing a CDK CLI command string. */
export interface ParsedCdkCommand {
  isCdk: boolean;
  subcommand: string | null;
  args: string[];
  rawCommand: string;
}

/** Result of validating a CDK CLI command against the read-only policy. */
export interface CdkCommandValidationResult {
  allowed: boolean;
  reason: string;
  command: string;
  subcommand: string | null;
}

/**
 * CDK global options that consume the following token as their value.
 * Only VALUE-TAKING options are listed. Boolean flags (--no-color, --verbose, etc.)
 * must NOT appear here — adding a boolean flag causes the parser to skip the token
 * that follows it (e.g. `cdk --no-color deploy` would have `deploy` skipped and
 * result in an allowed bare-cdk outcome, bypassing the destructive block).
 */
export const CDK_OPTIONS_WITH_VALUE = new Set([
  '--app',
  '--context',
  '-c',
  '--plugin',
  '--profile',
  '--proxy',
  '--ca-bundle-path',
  '--role-arn',
  '--output',
  '-o',
  '--unstable',
]);

/**
 * Tokenize a command string into parts, handling single- and double-quoted
 * strings so that multi-word option values (e.g. --app "node app.js") are
 * treated as a single token.
 */
function tokenizeForParse(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else current += ch;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasToken = true;
    } else if (ch === '"') {
      inDouble = true;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/**
 * Parse a CDK CLI command string to extract the subcommand.
 * Handles global flags that take a value so an attacker cannot smuggle a
 * destructive subcommand past the parser (e.g. `cdk --app "node app.js" deploy`).
 * Uses quote-aware tokenization so multi-word flag values are treated as one token.
 */
export function parseCdkCommand(command: string): ParsedCdkCommand {
  const trimmed = command.trim();
  const result: ParsedCdkCommand = {
    isCdk: false,
    subcommand: null,
    args: [],
    rawCommand: trimmed,
  };

  if (!trimmed) return result;

  const parts = tokenizeForParse(trimmed);
  if (parts.length === 0) return result;

  const binary = parts[0].toLowerCase();
  // Accept "cdk" and path variants like "/usr/local/bin/cdk".
  if (binary !== 'cdk' && !binary.endsWith('/cdk')) return result;
  result.isCdk = true;

  let skipNext = false;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];

    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (part.startsWith('-')) {
      // Options of the form --key=value don't consume the next token.
      if (!part.includes('=') && CDK_OPTIONS_WITH_VALUE.has(part)) {
        skipNext = true;
      }
      continue;
    }

    // First non-option token is the subcommand.
    result.subcommand = part.toLowerCase();
    result.args = parts.slice(i + 1);
    break;
  }

  return result;
}

/**
 * Validate a CDK CLI command against the read-only policy.
 * Returns null when the command is not a CDK CLI invocation (not in scope).
 */
export function validateCdkCommand(command: string): CdkCommandValidationResult | null {
  const parsed = parseCdkCommand(command);
  if (!parsed.isCdk) return null;

  if (!parsed.subcommand) {
    // Bare `cdk` or `cdk --version` prints help/version — harmless.
    return {
      allowed: true,
      reason: 'CDK CLI without a subcommand',
      command: parsed.rawCommand,
      subcommand: null,
    };
  }

  const sub = parsed.subcommand;

  // Explicitly block known destructive subcommands for a clear error message.
  const isDestructive = (DESTRUCTIVE_CDK_COMMANDS as ReadonlyArray<string>).includes(sub);
  if (isDestructive) {
    return {
      allowed: false,
      reason: `Destructive CDK command '${sub}' is blocked. Heimdall is read-only — suggest this command to the user to run manually instead.`,
      command: parsed.rawCommand,
      subcommand: sub,
    };
  }

  // Default-deny: only explicitly listed read-only subcommands are allowed.
  const isAllowed = (ALLOWED_CDK_COMMANDS as ReadonlyArray<string>).includes(sub);
  if (isAllowed) {
    return {
      allowed: true,
      reason: `Read-only CDK command '${sub}' is allowed`,
      command: parsed.rawCommand,
      subcommand: sub,
    };
  }

  return {
    allowed: false,
    reason: `Unknown CDK subcommand '${sub}' is blocked. Only read-only subcommands (ls, list, synth, synthesize, diff, metadata, context, notices, docs, doc, version, doctor, drift) are permitted.`,
    command: parsed.rawCommand,
    subcommand: sub,
  };
}
