/**
 * Tool plugin interface.
 *
 * A ToolPlugin is a self-contained descriptor for a diagnostic tool: it knows
 * its config key and how to construct a ToolDefinition given the loaded config
 * and compiled redaction rules. Centralising this in the plugin struct means
 * adding a new tool only requires:
 *   1. Implementing the factory in src/tools/<name>.ts
 *   2. Exporting a ToolPlugin from that file
 *   3. Adding it to TOOL_PLUGINS in src/agents/heimdall.ts
 *
 * The tool registration loop in heimdall.ts replaces the manual ALL_TOOLS map.
 */
import type { ToolDefinition } from '@flue/runtime';
import type { HeimdallConfig } from './config.ts';
import type { CompiledRedactionRule } from './regex-redact.ts';

export interface ToolPlugin {
  /** The key under `HeimdallConfig['tools']` that enables this tool. */
  key: string;
  /**
   * Factory that receives the full loaded config and compiled redaction rules
   * and returns a ready-to-use ToolDefinition. Credentials, URLs, and
   * per-tool config slices are resolved inside the factory — never from
   * model-selected arguments.
   */
  factory: (config: HeimdallConfig, rules: CompiledRedactionRule[]) => ToolDefinition;
}

/**
 * Instantiate all plugins and split them into an all-tools map and an
 * enabled-keys set (those whose config.tools[key] is truthy).
 */
export function buildToolRegistry(
  plugins: ToolPlugin[],
  config: HeimdallConfig,
  rules: CompiledRedactionRule[],
): { allTools: Record<string, ToolDefinition>; enabledKeys: Set<string> } {
  const allTools: Record<string, ToolDefinition> = {};
  const enabledKeys = new Set<string>();

  for (const plugin of plugins) {
    allTools[plugin.key] = plugin.factory(config, rules);
    if (config.tools[plugin.key as keyof typeof config.tools]) {
      enabledKeys.add(plugin.key);
    }
  }

  return { allTools, enabledKeys };
}
