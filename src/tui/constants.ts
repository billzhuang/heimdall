/**
 * Model configuration for Heimdall TUI
 */

export interface ModelInfo {
  id: string;
  label: string;
}

export const MODEL_MAP: Record<string, ModelInfo> = {
  sonnet: { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
  opus: { id: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
  haiku: { id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
  gpt: { id: 'gpt-5.2', label: 'GPT 5.2' },
  gemini: { id: 'gemini-2.5-pro-preview-05-06', label: 'Gemini 2.5 Pro' },
};

export function getModelId(modelName: string): string {
  const model = MODEL_MAP[modelName.toLowerCase()];
  return model?.id || MODEL_MAP.sonnet.id;
}
