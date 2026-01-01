// Model configuration - single source of truth
export interface ModelInfo {
  label: string;
  id: string;
}

export const MODEL_MAP: Record<string, ModelInfo> = {
  sonnet: {
    label: "Sonnet - Recommended",
    id: "claude-sonnet-4-5-20250929",
  },
  opus: {
    label: "Opus - Most capable",
    id: "claude-opus-4-5-20251101",
  },
  haiku: {
    label: "Haiku - Fastest",
    id: "claude-haiku-4-5-20251001",
  },
  gpt: {
    label: "GPT - OpenAI",
    id: "gpt-5.2",
  },
  gemini: {
    label: "Gemini - Google",
    id: "gemini-3-flash-preview",
  },
};

// Helper to get full model ID from shorthand
export function getModelId(shorthand: string): string {
  return MODEL_MAP[shorthand]?.id || shorthand;
}
