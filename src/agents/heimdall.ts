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
 * TOOL_PLUGINS below, and add a matching key to the config schema in
 * src/lib/config.ts.
 */
import { createAgent, defineAgentProfile } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime';
import { initTelemetry, isTelemetryEnabled, recordToolCall } from '../lib/telemetry.ts';
import { dirname, resolve } from 'node:path';
import { kubectlPlugin } from '../tools/kubectl.ts';
import { listContextsPlugin, listNamespacesPlugin } from '../tools/kubeconfig.ts';
import { helmReleasePlugin } from '../tools/helm.ts';
import { prometheusPlugin } from '../tools/prometheus.ts';
import { awsCliPlugin } from '../tools/aws.ts';
import { trivyScanPlugin } from '../tools/trivy.ts';
import { kubecostPlugin } from '../tools/kubecost.ts';
import { lokiPlugin } from '../tools/loki.ts';
import { jaegerPlugin } from '../tools/jaeger.ts';
import { datadogPlugin } from '../tools/datadog.ts';
import { newRelicPlugin } from '../tools/newrelic.ts';
import { cdkPlugin } from '../tools/cdk.ts';
import { buildToolRegistry, type ToolPlugin } from '../lib/plugin.ts';
import { readFileSync } from 'node:fs';
import { DEFAULT_MODEL } from '../lib/model.ts';
import { SUBAGENT_DESCRIPTIONS, SUBAGENT_INSTRUCTIONS, buildInstructions, type SubagentName, type ToolConfigKey } from '../lib/instructions.ts';
import { loadConfig } from '../lib/config.ts';
import { compileRules } from '../lib/regex-redact.ts';
import { loadRunbooks } from '../lib/runbooks.ts';
import { selectDiverseEntries, buildRagContext } from '../lib/rag.ts';
import type { TaskHistoryEntry } from '../lib/task-history.ts';

const config = loadConfig();
const regexRedactionRules = config.redaction?.enabled ? compileRules(config.redaction.rules ?? []) : [];

initTelemetry(config.telemetry ?? { enabled: false });

const configDir = dirname(resolve(process.env.HEIMDALL_CONFIG ?? 'heimdall.config.yaml'));
const runbookContext = loadRunbooks(configDir, config.runbooks ?? []);

/** Load task history synchronously for RAG context injection at agent startup. */
function loadTaskHistorySync(logPath: string): TaskHistoryEntry[] {
  try {
    const raw = readFileSync(logPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    // Cap at the last 100 entries to bound startup latency and memory for large histories.
    // MMR diversity selection works well within this window for typical SRE corpora.
    return lines.slice(-100).flatMap((l) => {
      try {
        const parsed: unknown = JSON.parse(l);
        if (parsed !== null && typeof parsed === 'object') {
          return [parsed as TaskHistoryEntry];
        }
        return [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

const TASK_HISTORY_NAME = 'task-history.jsonl';

const ragContext = (() => {
  if (config.learning?.rag?.enabled !== true) return undefined;
  const logPath = config.learning.file
    ? resolve(config.learning.file)
    : resolve(configDir, 'scenarios', TASK_HISTORY_NAME);
  const history = loadTaskHistorySync(logPath);
  if (history.length === 0) return undefined;
  const topK = config.learning.rag.topK ?? 5;
  const diverse = selectDiverseEntries(history, topK);
  return buildRagContext(diverse);
})();

const lockedNs = config.namespace?.locked;

/**
 * Ordered list of all tool plugins. Each plugin is self-contained: it declares
 * its config key and provides a factory that builds the ToolDefinition.
 * Adding a new tool only requires exporting a ToolPlugin from its module and
 * appending it here (plus a matching key in src/lib/config.ts).
 */
const TOOL_PLUGINS: ToolPlugin[] = [
  kubectlPlugin,
  listContextsPlugin,
  listNamespacesPlugin,
  helmReleasePlugin,
  prometheusPlugin,
  awsCliPlugin,
  trivyScanPlugin,
  kubecostPlugin,
  lokiPlugin,
  jaegerPlugin,
  datadogPlugin,
  newRelicPlugin,
  cdkPlugin,
];

const { allTools: ALL_TOOLS, enabledKeys } = buildToolRegistry(TOOL_PLUGINS, config, regexRedactionRules);
const enabledToolKeys = new Set(Array.from(enabledKeys) as ToolConfigKey[]);

const telemetryEnabled = isTelemetryEnabled();

function wrapWithTiming(tool: ToolDefinition): ToolDefinition {
  const t = tool as ToolDefinition & { execute: (input: Record<string, unknown>) => Promise<string> };
  const orig = t.execute.bind(t);
  return Object.assign({}, tool, {
    execute: async (input: Record<string, unknown>): Promise<string> => {
      const start = Date.now();
      try {
        return await orig(input);
      } finally {
        recordToolCall(Date.now() - start);
      }
    },
  }) as ToolDefinition;
}

const clusterTools = Object.keys(ALL_TOOLS)
  .filter((key) => enabledToolKeys.has(key as ToolConfigKey))
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

export default createAgent(() => ({
  model: DEFAULT_MODEL,
  instructions: buildInstructions(enabledToolKeys, lockedNs, runbookContext, ragContext, config.slos ?? []),
  tools: clusterTools,
  subagents,
}));
