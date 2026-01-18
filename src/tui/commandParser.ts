import { MODEL_MAP } from './constants.js';

// Slash command types
export type SlashCommand =
  | { type: 'ctx' }
  | { type: 'ns' }
  | { type: 'model' }
  | { type: 'help' }
  | { type: 'exit' }
  | { type: 'clear' }
  | { type: 'new' }
  | { type: 'compact' }
  | { type: 'context'; subcommand?: 'full' | 'raw' };

// General query command - all user queries go to LLM
export interface QueryCommand {
  type: 'query';
  text: string;
  model?: string;
}

// Unknown command
export interface UnknownCommand {
  type: 'unknown';
  raw: string;
}

export type ParsedCommand = SlashCommand | QueryCommand | UnknownCommand;

// Valid slash commands with descriptions
export const SLASH_COMMANDS: Record<string, { type: SlashCommand['type']; description: string }> = {
  '/ctx': { type: 'ctx', description: 'Select Kubernetes context' },
  '/ns': { type: 'ns', description: 'Select namespace' },
  '/model': { type: 'model', description: 'Select LLM model' },
  '/context': { type: 'context', description: 'Show conversation memory stats (/context full for turns, /context raw for prompt)' },
  '/help': { type: 'help', description: 'Show available commands' },
  '/clear': { type: 'clear', description: 'Clear conversation history' },
  '/new': { type: 'new', description: 'Start new conversation' },
  '/compact': { type: 'compact', description: 'Compact conversation context' },
  '/exit': { type: 'exit', description: 'Exit Heimdall' },
  '/quit': { type: 'exit', description: 'Exit Heimdall' },
};

// Control command aliases
const HELP_ALIASES = ['help', '?', 'h'];
const EXIT_ALIASES = ['exit', 'quit', 'q'];

/**
 * Parse user input into a structured command
 * All non-slash commands are passed directly to the LLM
 */
export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  
  // Empty input
  if (!trimmed) {
    return { type: 'unknown', raw: input };
  }

  const normalized = trimmed.toLowerCase();

  // Check for slash commands first
  if (trimmed.startsWith('/')) {
    const parts = trimmed.split(/\s+/);
    const slashCmd = parts[0].toLowerCase();
    const cmdInfo = SLASH_COMMANDS[slashCmd];
    if (cmdInfo) {
      // Handle /context subcommands
      if (cmdInfo.type === 'context' && parts.length > 1) {
        const sub = parts[1].toLowerCase();
        if (sub === 'full' || sub === 'raw') {
          return { type: 'context', subcommand: sub } as SlashCommand;
        }
      }
      return { type: cmdInfo.type } as SlashCommand;
    }
    // Unknown slash command
    return { type: 'unknown', raw: input };
  }

  // Check for control commands (help, exit)
  if (HELP_ALIASES.includes(normalized)) {
    return { type: 'help' };
  }
  if (EXIT_ALIASES.includes(normalized)) {
    return { type: 'exit' };
  }

  // Everything else goes to the LLM as a query
  const model = extractModel(normalized);
  return {
    type: 'query',
    text: trimmed,
    model,
  };
}

/**
 * Extract model name from input if present
 */
function extractModel(input: string): string | undefined {
  const modelNames = Object.keys(MODEL_MAP);
  for (const modelName of modelNames) {
    if (new RegExp(`\\b${modelName}\\b`).test(input)) {
      return modelName;
    }
  }
  return undefined;
}

/**
 * Check if a command is a slash command
 */
export function isSlashCommand(cmd: ParsedCommand): cmd is SlashCommand {
  return ['ctx', 'ns', 'model', 'help', 'exit', 'clear', 'new', 'compact', 'context'].includes(cmd.type);
}

/**
 * Check if a command is a general query
 */
export function isQuery(cmd: ParsedCommand): cmd is QueryCommand {
  return cmd.type === 'query';
}

/**
 * Get all valid slash command strings
 */
export function getSlashCommands(): string[] {
  return Object.keys(SLASH_COMMANDS);
}

/**
 * Get slash commands with descriptions for autocomplete
 */
export function getSlashCommandsWithDescriptions(): Array<{ command: string; description: string }> {
  return Object.entries(SLASH_COMMANDS).map(([cmd, info]) => ({
    command: cmd,
    description: info.description,
  }));
}

/**
 * Filter slash commands by prefix
 */
export function filterSlashCommands(prefix: string): Array<{ command: string; description: string }> {
  const lowerPrefix = prefix.toLowerCase();
  return getSlashCommandsWithDescriptions().filter(
    item => item.command.toLowerCase().startsWith(lowerPrefix)
  );
}
