/**
 * Model configuration for Heimdall TUI
 */

export interface ModelInfo {
  id: string;
  label: string;
}

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
