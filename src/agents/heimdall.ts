/**
 * Heimdall — an AI-powered, read-only Kubernetes SRE agent.
 *
 * Cluster access flows exclusively through the read-only `kubectl` tool, so the
 * agent can investigate but never mutate a cluster. Deep investigations can be
 * delegated to read-only specialist subagents.
 *
 * Which tools are enabled is controlled by `heimdall.config.yaml` (or the path
 * in `HEIMDALL_CONFIG`).  To add a new tool: add it to ALL_TOOLS here and add
 * a matching key to the config schema in src/lib/config.ts — TypeScript will
 * error at this call site if the two get out of sync.
 */
import { createAgent, defineAgentProfile } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime';
import { dirname, resolve } from 'node:path';
import { makeKubectl } from '../tools/kubectl.ts';
import { listContexts, makeListNamespaces } from '../tools/kubeconfig.ts';
import { makeHelmRelease } from '../tools/helm.ts';
import { makePrometheusQuery } from '../tools/prometheus.ts';
import { makeAwsCli } from '../tools/aws.ts';
import { makeTrivyScan } from '../tools/trivy.ts';
import { makeKubecostQuery } from '../tools/kubecost.ts';
import { makeLokiQuery } from '../tools/loki.ts';
import { makeJaegerQuery } from '../tools/jaeger.ts';
import { makeDatadogQuery } from '../tools/datadog.ts';
import { readFileSync } from 'node:fs';
import { DEFAULT_MODEL } from '../lib/model.ts';
import { SUBAGENT_DESCRIPTIONS, SUBAGENT_INSTRUCTIONS, buildInstructions, type SubagentName, type ToolConfigKey } from '../lib/instructions.ts';
import { loadConfig } from '../lib/config.ts';
import type { HeimdallConfig } from '../lib/config.ts';
import { compileRules } from '../lib/regex-redact.ts';
import { loadRunbooks } from '../lib/runbooks.ts';
import { selectDiverseEntries, buildRagContext } from '../lib/rag.ts';
import type { TaskHistoryEntry } from '../lib/task-history.ts';

const config = loadConfig();
const regexRedactionRules = config.redaction?.enabled ? compileRules(config.redaction.rules ?? []) : [];

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

// Typed against the config schema keys so TypeScript enforces that every key in
// HeimdallConfig['tools'] has a corresponding tool here — adding a config key
// without adding the tool (or vice versa) is a compile-time error.
const lockedNs = config.namespace?.locked;

const ALL_TOOLS: Record<keyof HeimdallConfig['tools'], ToolDefinition> = {
  kubectl: makeKubectl(config.audit, config.redactSecrets, regexRedactionRules, lockedNs),
  listContexts,
  listNamespaces: makeListNamespaces(lockedNs),
  helmRelease: makeHelmRelease(lockedNs),
  prometheusQuery: makePrometheusQuery(config.prometheus, regexRedactionRules),
  awsCli: makeAwsCli({ audit: config.audit }, regexRedactionRules),
  trivyScan: makeTrivyScan({ audit: config.audit }, regexRedactionRules),
  kubecostQuery: makeKubecostQuery(config.kubecost, regexRedactionRules, lockedNs),
  lokiQuery: makeLokiQuery(config.loki, regexRedactionRules, lockedNs),
  jaegerQuery: makeJaegerQuery(config.jaeger, regexRedactionRules),
  datadogQuery: makeDatadogQuery(config.datadog, regexRedactionRules),
};

const enabledToolKeys = new Set(
  (Object.keys(ALL_TOOLS) as ToolConfigKey[]).filter((key) => config.tools[key]),
);

const clusterTools = (Object.keys(ALL_TOOLS) as ToolConfigKey[])
  .filter((key) => enabledToolKeys.has(key))
  .map((key) => ALL_TOOLS[key]);

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
  instructions: buildInstructions(enabledToolKeys, lockedNs, runbookContext, ragContext),
  tools: clusterTools,
  subagents,
}));
