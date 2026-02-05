/**
 * Safety hooks for Heimdall agent - provides programmatic defense-in-depth
 * by blocking destructive kubectl and AWS CLI commands at the SDK level.
 */
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

/**
 * List of destructive kubectl subcommands that should be blocked
 */
export const DESTRUCTIVE_KUBECTL_COMMANDS = [
  'apply',
  'create',
  'delete',
  'patch',
  'edit',
  'replace',
  'scale',
  'drain',
  'cordon',
  'uncordon',
  'taint',
  'rollout',
  // Commands that can execute arbitrary code or exfiltrate data
  'exec',
  'port-forward',
  'attach',
  'cp',
  'debug',
] as const;

/**
 * List of allowed read-only kubectl subcommands
 */
export const ALLOWED_KUBECTL_COMMANDS = [
  'get',
  'describe',
  'logs',
  'top',
  'explain',
  'api-resources',
  'api-versions',
  'version',
  'cluster-info',
  'config',
  'auth',
] as const;

/**
 * List of destructive AWS CLI subcommands (patterns) that should be blocked
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
 * List of allowed AWS CLI subcommands (patterns)
 */
export const ALLOWED_AWS_PATTERNS = [
  'describe-',
  'get-',
  'list-',
  'show-',
] as const;

export type DestructiveCommand = typeof DESTRUCTIVE_KUBECTL_COMMANDS[number];
export type AllowedCommand = typeof ALLOWED_KUBECTL_COMMANDS[number];

/**
 * Result of parsing a kubectl command
 */
export interface ParsedKubectlCommand {
  isKubectl: boolean;
  subcommand: string | null;
  args: string[];
  rawCommand: string;
}

/**
 * Result of command validation
 */
export interface CommandValidationResult {
  allowed: boolean;
  reason: string;
  command: string;
  subcommand: string | null;
}

/**
 * Parse a command string to extract kubectl subcommand.
 * Handles various formats like:
 * - kubectl get pods
 * - kubectl --context=prod get pods
 * - kubectl -n kube-system get pods
 */
export function parseKubectlCommand(command: string): ParsedKubectlCommand {
  const trimmed = command.trim();
  const result: ParsedKubectlCommand = {
    isKubectl: false,
    subcommand: null,
    args: [],
    rawCommand: trimmed,
  };

  if (!trimmed) {
    return result;
  }

  // Split command into parts, handling quoted strings
  const parts = trimmed.split(/\s+/).filter(Boolean);
  
  if (parts.length === 0) {
    return result;
  }

  // Check if this is a kubectl command
  const firstPart = parts[0].toLowerCase();
  if (firstPart !== 'kubectl') {
    return result;
  }

  result.isKubectl = true;

  // Options that take a value as the next argument
  // CRITICAL: This must include ALL kubectl global options that take values
  // to prevent bypass attacks like: kubectl --v 5 delete pods
  const optionsWithValue = new Set([
    // Common options
    '-n', '--namespace',
    '-c', '--container',
    '-l', '--selector',
    '-f', '--filename',
    '-o', '--output',
    // Global options from `kubectl options`
    '--as',
    '--as-group',
    '--as-uid',
    '--cache-dir',
    '--certificate-authority',
    '--client-certificate',
    '--client-key',
    '--cluster',
    '--context',
    '--kubeconfig',
    '--log-flush-frequency',
    '--password',
    '--profile',
    '--profile-output',
    '--request-timeout',
    '--server', '-s',
    '--tls-server-name',
    '--token',
    '--user',
    '--username',
    '--v', '-v',  // verbosity level
    '--vmodule',
  ]);

  // Find the subcommand (first non-option argument after kubectl)
  let skipNext = false;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    
    // Skip the value of a previous option
    if (skipNext) {
      skipNext = false;
      continue;
    }
    
    // Skip options (start with - or --)
    if (part.startsWith('-')) {
      // Handle --option=value format (no skip needed)
      if (part.includes('=')) {
        continue;
      }
      // Check if this option takes a value
      if (optionsWithValue.has(part)) {
        skipNext = true;
      }
      continue;
    }
    
    // This is the subcommand
    result.subcommand = part.toLowerCase();
    result.args = parts.slice(i + 1);
    break;
  }

  return result;
}

/**
 * Check if a command is destructive (modifies cluster state)
 */
export function isDestructiveCommand(command: string): boolean {
  const parsed = parseKubectlCommand(command);
  
  if (!parsed.isKubectl || !parsed.subcommand) {
    return false;
  }

  return DESTRUCTIVE_KUBECTL_COMMANDS.includes(
    parsed.subcommand as DestructiveCommand
  );
}

/**
 * Validate a command and return detailed result
 */
export function validateCommand(command: string): CommandValidationResult {
  const parsed = parseKubectlCommand(command);

  // Check if this is an AWS command
  const awsValidation = validateAwsCommand(command);
  if (awsValidation !== null) {
    return awsValidation;
  }

  // Non-kubectl commands (and non-AWS) are allowed
  if (!parsed.isKubectl) {
    return {
      allowed: true,
      reason: 'Not a kubectl command',
      command: parsed.rawCommand,
      subcommand: null,
    };
  }

  // kubectl without subcommand - allow (will show help)
  if (!parsed.subcommand) {
    return {
      allowed: true,
      reason: 'kubectl without subcommand',
      command: parsed.rawCommand,
      subcommand: null,
    };
  }

  // Check if destructive
  if (DESTRUCTIVE_KUBECTL_COMMANDS.includes(parsed.subcommand as DestructiveCommand)) {
    return {
      allowed: false,
      reason: `Destructive command '${parsed.subcommand}' is blocked. Run manually: ${parsed.rawCommand}`,
      command: parsed.rawCommand,
      subcommand: parsed.subcommand,
    };
  }

  // Check if explicitly allowed (default-deny policy for kubectl commands)
  if (ALLOWED_KUBECTL_COMMANDS.includes(parsed.subcommand as AllowedCommand)) {
    return {
      allowed: true,
      reason: `Read-only command '${parsed.subcommand}' is allowed`,
      command: parsed.rawCommand,
      subcommand: parsed.subcommand,
    };
  }

  // Unknown subcommand - block by default (security: default-deny policy)
  // This prevents unknown commands like 'proxy' from bypassing safety checks
  return {
    allowed: false,
    reason: `Unknown kubectl subcommand '${parsed.subcommand}' is blocked. Only explicitly allowed read-only commands are permitted.`,
    command: parsed.rawCommand,
    subcommand: parsed.subcommand,
  };
}

/**
 * Result of parsing an AWS CLI command
 */
export interface ParsedAwsCommand {
  isAws: boolean;
  service: string | null;
  subcommand: string | null;
  args: string[];
  rawCommand: string;
}

/**
 * Parse an AWS CLI command to extract service and subcommand
 * Handles various formats like:
 * - aws eks describe-cluster --name my-cluster
 * - aws --region us-west-2 ec2 describe-instances
 * - aws iam list-users
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

  if (!trimmed) {
    return result;
  }

  // Split command into parts
  const parts = trimmed.split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return result;
  }

  // Check if this is an AWS command
  const firstPart = parts[0].toLowerCase();
  if (firstPart !== 'aws') {
    return result;
  }

  result.isAws = true;

  // AWS global options that take a value
  const awsOptionsWithValue = new Set([
    '--region',
    '--profile',
    '--output',
    '--endpoint-url',
    '--color',
    '--cli-connect-timeout',
    '--cli-read-timeout',
  ]);

  // Find the service name (first non-option argument after 'aws')
  let skipNext = false;
  let serviceIndex = -1;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];

    if (skipNext) {
      skipNext = false;
      continue;
    }

    // Skip options
    if (part.startsWith('-')) {
      if (part.includes('=')) {
        continue;
      }
      if (awsOptionsWithValue.has(part)) {
        skipNext = true;
      }
      continue;
    }

    // This is the service name
    result.service = part.toLowerCase();
    serviceIndex = i;
    break;
  }

  // Find the subcommand (first non-option argument after service)
  if (serviceIndex !== -1 && serviceIndex + 1 < parts.length) {
    skipNext = false;

    for (let i = serviceIndex + 1; i < parts.length; i++) {
      const part = parts[i];

      if (skipNext) {
        skipNext = false;
        continue;
      }

      // Skip options
      if (part.startsWith('-')) {
        if (!part.includes('=')) {
          skipNext = true;
        }
        continue;
      }

      // This is the subcommand
      result.subcommand = part.toLowerCase();
      result.args = parts.slice(i + 1);
      break;
    }
  }

  return result;
}

/**
 * Validate an AWS command and return result, or null if not an AWS command
 */
export function validateAwsCommand(command: string): CommandValidationResult | null {
  const parsed = parseAwsCommand(command);

  // Not an AWS command
  if (!parsed.isAws) {
    return null;
  }

  // AWS without service or subcommand - allow (will show help)
  if (!parsed.service || !parsed.subcommand) {
    return {
      allowed: true,
      reason: 'AWS CLI without complete command',
      command: parsed.rawCommand,
      subcommand: null,
    };
  }

  const subcommand = parsed.subcommand;

  // Check if destructive (matches any destructive pattern)
  const isDestructive = DESTRUCTIVE_AWS_PATTERNS.some(pattern =>
    subcommand.includes(pattern.replace('-', ''))
  );

  if (isDestructive) {
    return {
      allowed: false,
      reason: `Destructive AWS command '${parsed.service} ${subcommand}' is blocked. Run manually: ${parsed.rawCommand}`,
      command: parsed.rawCommand,
      subcommand: `${parsed.service} ${subcommand}`,
    };
  }

  // Check if allowed (matches any allowed pattern)
  const isAllowed = ALLOWED_AWS_PATTERNS.some(pattern =>
    subcommand.startsWith(pattern.replace('-', ''))
  );

  if (isAllowed) {
    return {
      allowed: true,
      reason: `Read-only AWS command '${parsed.service} ${subcommand}' is allowed`,
      command: parsed.rawCommand,
      subcommand: `${parsed.service} ${subcommand}`,
    };
  }

  // Unknown subcommand - block by default (security: default-deny policy)
  return {
    allowed: false,
    reason: `Unknown AWS subcommand '${parsed.service} ${subcommand}' is blocked. Only explicitly allowed read-only commands are permitted.`,
    command: parsed.rawCommand,
    subcommand: `${parsed.service} ${subcommand}`,
  };
}

const DEFAULT_CACHE_TTL_SECONDS = 30;
const CACHE_DIR_NAME = 'heimdall-kubectl-cache';

function isCacheEnabled(): boolean {
  return process.env.HEIMDALL_KUBECTL_CACHE !== '0';
}

function getCacheTtlSeconds(): number {
  const raw = process.env.HEIMDALL_KUBECTL_CACHE_TTL;
  if (!raw) return DEFAULT_CACHE_TTL_SECONDS;
  const ttl = Number.parseInt(raw, 10);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_CACHE_TTL_SECONDS;
}

function getCacheDir(): string {
  const baseDir = process.env.HEIMDALL_KUBECTL_CACHE_DIR || tmpdir();
  return joinPath(baseDir, CACHE_DIR_NAME);
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function splitByFirstPipe(command: string): { head: string; tail: string } {
  const pipeIndex = command.indexOf('|');
  if (pipeIndex === -1) {
    return { head: command, tail: '' };
  }
  return {
    head: command.slice(0, pipeIndex).trimEnd(),
    tail: command.slice(pipeIndex),
  };
}

function isJsonOutput(command: string): boolean {
  return /(?:^|\s)(-o|--output)(?:=|\s+)json(?:\s|$)/i.test(command);
}

function buildCachedKubectlCommand(command: string): string | null {
  if (!isCacheEnabled()) return null;
  if (!isJsonOutput(command)) return null;

  const { head, tail } = splitByFirstPipe(command);
  const headTrimmed = head.trim();

  if (!headTrimmed.startsWith('kubectl ')) {
    return null;
  }

  const parsed = parseKubectlCommand(headTrimmed);
  if (!parsed.isKubectl || parsed.subcommand !== 'get') {
    return null;
  }

  // Avoid double-wrapping if the command was already rewritten.
  if (command.includes(CACHE_DIR_NAME)) {
    return null;
  }

  const normalizedHead = normalizeCommand(headTrimmed);
  const hash = createHash('sha1').update(normalizedHead).digest('hex');
  const cacheDir = getCacheDir();
  const cacheFile = joinPath(cacheDir, `${hash}.json`);
  const ttlSeconds = getCacheTtlSeconds();

  const cacheDirQuoted = shellQuote(cacheDir);
  const cacheFileQuoted = shellQuote(cacheFile);
  const ttlQuoted = shellQuote(String(ttlSeconds));

  const cachePrefix = [
    `CACHE_DIR=${cacheDirQuoted};`,
    `CACHE_FILE=${cacheFileQuoted};`,
    `TTL=${ttlQuoted};`,
    'mkdir -p "$CACHE_DIR";',
    'if [ -f "$CACHE_FILE" ]; then',
    '  ts=$(stat -f %m "$CACHE_FILE" 2>/dev/null || stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0);',
    '  now=$(date +%s);',
    '  if [ $((now - ts)) -lt "$TTL" ]; then',
    '    cat "$CACHE_FILE";',
    '  else',
    `    ${headTrimmed} | tee "$CACHE_FILE";`,
    '  fi;',
    'else',
    `  ${headTrimmed} | tee "$CACHE_FILE";`,
    'fi',
  ].join(' ');

  return tail ? `${cachePrefix} ${tail}` : cachePrefix;
}


/**
 * Hook input structure from SDK - using the SDK's HookInput union type
 * We cast to this when we know we're handling PreToolUse
 */
export interface PreToolUseInput {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
}

/**
 * Hook output for allowing/denying tool execution
 */
export interface HookOutput {
  hookEventName?: string;
  permissionDecision?: 'allow' | 'deny' | 'ask';
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
  continue?: boolean;
}

/**
 * Callback for when a command is blocked
 */
export type OnCommandBlockedCallback = (
  command: string,
  reason: string,
  suggestedManualCommand: string
) => void;

/**
 * Create the PreToolUse hook for safety validation.
 * This hook intercepts Bash tool calls and blocks destructive kubectl commands.
 */
export function createPreToolUseHook(
  onBlocked?: OnCommandBlockedCallback
): (input: unknown, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<HookOutput> {
  return async (input: unknown, _toolUseId: string | undefined, _options: { signal: AbortSignal }): Promise<HookOutput> => {
    const hookInput = input as PreToolUseInput;
    
    // Only check Bash tool
    if (hookInput.tool_name !== 'Bash') {
      return { continue: true };
    }

    const toolInput = hookInput.tool_input as { command?: string } | undefined;
    const command = toolInput?.command;
    if (!command || typeof command !== 'string') {
      return { continue: true };
    }

    const validation = validateCommand(command);

    if (!validation.allowed) {
      // Notify callback if provided
      onBlocked?.(command, validation.reason, command);

      return {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: validation.reason,
      };
    }
    const cachedCommand = buildCachedKubectlCommand(command);
    if (cachedCommand) {
      return {
        continue: true,
        updatedInput: {
          ...(toolInput || {}),
          command: cachedCommand,
        },
      };
    }

    return { continue: true };
  };
}

/**
 * Pre-compact hook input from SDK
 */
export interface PreCompactInput {
  hook_event_name: 'PreCompact';
  trigger: 'auto' | 'manual';
  custom_instructions: string | null;
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
}

/**
 * Callback for when compaction occurs
 */
export type OnCompactionCallback = (
  trigger: 'auto' | 'manual',
  preservedContext: string
) => void;

/**
 * Create the pre_compact hook for context management.
 * This hook is called when the SDK is about to compact context.
 */
export function createPreCompactHook(
  onCompaction?: OnCompactionCallback
): (input: unknown, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<HookOutput> {
  return async (input: unknown, _toolUseId: string | undefined, _options: { signal: AbortSignal }): Promise<HookOutput> => {
    const hookInput = input as PreCompactInput;
    
    // Notify callback if provided
    onCompaction?.(hookInput.trigger, hookInput.custom_instructions || '');

    // Return empty to allow default compaction behavior
    return { continue: true };
  };
}

/**
 * Default maximum turns before termination
 */
export const DEFAULT_MAX_TURNS = 15;
