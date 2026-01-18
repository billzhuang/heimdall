/**
 * Model configuration for Heimdall TUI
 */

export interface ModelInfo {
  id: string;
  label: string;
}

/**
 * Command tip for the welcome screen tips panel
 */
export interface CommandTip {
  command: string;
  description: string;
}

/**
 * Heimdall version number
 */
export const HEIMDALL_VERSION = '0.1.0';

/**
 * ASCII art logo for Heimdall welcome screen
 */
export const HEIMDALL_ASCII_ART = `  _   _      _               _       _ _ 
 | | | | ___(_)_ __ ___   __| | __ _| | |
 | |_| |/ _ \\ | '_ \` _ \\ / _\` |/ _\` | | |
 |  _  |  __/ | | | | | | (_| | (_| | | |
 |_| |_|\\___|_|_| |_| |_|\\__,_|\\__,_|_|_|`;

/**
 * Tips displayed on the welcome screen showing available commands
 */
export const WELCOME_TIPS: CommandTip[] = [
  { command: '/ctx', description: 'Switch Kubernetes context' },
  { command: '/ns', description: 'Switch namespace' },
  { command: '/model', description: 'Change AI model' },
  { command: '/help', description: 'Show all commands' },
  { command: '/clear', description: 'Clear conversation' },
  { command: '/exit', description: 'Exit Heimdall' },
];

export const MODEL_MAP: Record<string, ModelInfo> = {
  sonnet: { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
  opus: { id: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5' },
  haiku: { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  gpt: { id: 'gpt-5.2', label: 'GPT 5.2' },
  gemini: { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro' },
};

export function getModelId(modelName: string): string {
  const model = MODEL_MAP[modelName.toLowerCase()];
  return model?.id || MODEL_MAP.sonnet.id;
}


/**
 * Format a version string to ensure it matches the vX.Y.Z format.
 * If the version already starts with 'v', it's returned as-is.
 * Otherwise, 'v' is prepended.
 * 
 * @param version - The version string to format
 * @returns The formatted version string in vX.Y.Z format
 */
export function formatVersion(version: string): string {
  if (!version) return 'v?.?.?';
  const trimmed = version.trim();
  if (trimmed.startsWith('v') || trimmed.startsWith('V')) {
    return trimmed.toLowerCase().replace(/^v/, 'v');
  }
  return `v${trimmed}`;
}
