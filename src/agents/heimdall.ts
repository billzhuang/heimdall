/**
 * Heimdall — an AI-powered, read-only Kubernetes SRE agent.
 *
 * Cluster access flows exclusively through the read-only `kubectl` tool, so the
 * agent can investigate but never mutate a cluster. Deep investigations can be
 * delegated to read-only specialist subagents.
 *
 * Which tools are enabled is controlled by `heimdall.config.yaml` (or the path
 * in `HEIMDALL_CONFIG`). Each tool is a self-contained ToolPlugin — to add a
 * new tool, export a ToolPlugin from its src/tools/<name>.ts file, add it to
 * ALL_TOOL_PLUGINS in src/tools/index.ts, and add a matching key to the
 * config schema in src/lib/config.ts.
 */
import { defineAgent, defineAgentProfile } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime';
import { initTelemetry, isTelemetryEnabled, recordToolCall, startOtelExport } from '../lib/telemetry.ts';
import { resolve } from 'node:path';
import { ALL_TOOL_PLUGINS } from '../tools/index.ts';
import { buildToolRegistry } from '../lib/plugin.ts';
import { readJsonlFileSync } from '../lib/jsonl.ts';
import { DEFAULT_MODEL } from '../lib/model.ts';
import { SUBAGENT_DESCRIPTIONS, SUBAGENT_INSTRUCTIONS, buildInstructions, type SubagentName, type ToolConfigKey } from '../lib/instructions.ts';
import { loadConfig, resolveConfigDir } from '../lib/config.ts';
import { compileRules } from '../lib/regex-redact.ts';
import { loadRunbooks } from '../lib/runbooks.ts';
import { selectDiverseEntries, buildRagContext } from '../lib/rag.ts';
import { resolveTaskHistoryFilePath, type TaskHistoryEntry } from '../lib/task-history.ts';
import { queryTopBaselines, buildBaselineContext, resolveBaselineFilePath, type BaselineEntry } from '../lib/baseline.ts';
import { getMessage } from '../lib/error-utils.ts';

const config = loadConfig();
const regexRedactionRules = config.redaction?.enabled ? compileRules(config.redaction.rules ?? []) : [];

initTelemetry(config.telemetry ?? { enabled: false });
startOtelExport(config.otel ?? { enabled: false });

const configDir = resolveConfigDir();
const runbookContext = loadRunbooks(configDir, config.runbooks ?? []);

/** Load task history synchronously for RAG context injection at agent startup. */
function loadTaskHistorySync(logPath: string): TaskHistoryEntry[] {
  // Cap at the last 100 entries to bound startup latency and memory for large histories.
  // MMR diversity selection works well within this window for typical SRE corpora.
  return readJsonlFileSync<TaskHistoryEntry>(logPath, { tail: 100 });
}

const ragContext = (() => {
  if (config.learning?.rag?.enabled !== true) return undefined;
  const logPath = resolveTaskHistoryFilePath(config.learning.file, resolve(configDir, 'scenarios'), configDir);
  const history = loadTaskHistorySync(logPath);
  if (history.length === 0) return undefined;
  const topK = config.learning.rag.topK ?? 5;
  const diverse = selectDiverseEntries(history, topK);
  return buildRagContext(diverse);
})();

/** Load baseline entries synchronously (same pattern as task history). */
function loadBaselinesSync(filePath: string): BaselineEntry[] {
  return readJsonlFileSync<BaselineEntry>(filePath, {
    onError: (err) => process.stderr.write(`[heimdall] Warning: could not read baseline file: ${getMessage(err)}\n`),
  });
}

const baselineContext = (() => {
  if (config.learning?.enabled === false) return undefined;
  const baselinePath = resolveBaselineFilePath(config.learning?.baselineFile, configDir);
  const baselines = loadBaselinesSync(baselinePath);
  if (baselines.length === 0) return undefined;
  const top = queryTopBaselines(baselines, 10);
  if (top.length === 0) return undefined;
  return buildBaselineContext(top);
})();

const lockedNs = config.namespace?.locked;

const { allTools: ALL_TOOLS, enabledKeys: enabledToolKeys } = buildToolRegistry(ALL_TOOL_PLUGINS, config, regexRedactionRules);

const telemetryEnabled = isTelemetryEnabled();

function wrapWithTiming(tool: ToolDefinition): ToolDefinition {
  const orig = tool.run.bind(tool);
  return Object.assign({}, tool, {
    run: async (context: Parameters<typeof orig>[0]) => {
      const start = Date.now();
      try {
        return await orig(context);
      } finally {
        recordToolCall(Date.now() - start);
      }
    },
  }) as ToolDefinition;
}

const clusterTools = (Object.keys(ALL_TOOLS) as ToolConfigKey[])
  .filter((key) => enabledToolKeys.has(key))
  .map((key) => (telemetryEnabled ? wrapWithTiming(ALL_TOOLS[key]) : ALL_TOOLS[key]));

if (clusterTools.length === 0) {
  console.warn('[heimdall] No tools are enabled in heimdall.config.yaml — the agent has no cluster access.');
}

const subagents = (Object.keys(SUBAGENT_INSTRUCTIONS) as SubagentName[]).map((name) =>
  defineAgentProfile({
    name,
    description: SUBAGENT_DESCRIPTIONS[name],
    model: DEFAULT_MODEL,
    instructions: SUBAGENT_INSTRUCTIONS[name],
    tools: clusterTools,
  }),
);

export const description = 'Read-only Kubernetes SRE assistant: diagnose cluster issues with kubectl + AI reasoning.';

export default defineAgent(() => ({
  model: DEFAULT_MODEL,
  instructions: buildInstructions(enabledToolKeys, lockedNs, runbookContext, ragContext, config.slos ?? [], baselineContext),
  tools: clusterTools,
  subagents,
}));
