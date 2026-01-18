/**
 * Safety hooks for Heimdall agent - provides programmatic defense-in-depth
 * by blocking destructive kubectl commands at the SDK level.
 */

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
  const optionsWithValue = new Set(['-n', '--namespace', '-c', '--container', '-l', '--selector', '-f', '--filename', '-o', '--output']);

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

  // Non-kubectl commands are allowed
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

  // Check if explicitly allowed
  if (ALLOWED_KUBECTL_COMMANDS.includes(parsed.subcommand as AllowedCommand)) {
    return {
      allowed: true,
      reason: `Read-only command '${parsed.subcommand}' is allowed`,
      command: parsed.rawCommand,
      subcommand: parsed.subcommand,
    };
  }

  // Unknown subcommand - allow (conservative approach)
  return {
    allowed: true,
    reason: `Unknown subcommand '${parsed.subcommand}' - allowing`,
    command: parsed.rawCommand,
    subcommand: parsed.subcommand,
  };
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
