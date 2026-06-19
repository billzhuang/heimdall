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
import { kubectl } from '../tools/kubectl.ts';
import { listContexts, listNamespaces } from '../tools/kubeconfig.ts';
import { DEFAULT_MODEL } from '../lib/model.ts';
import { SUBAGENT_INSTRUCTIONS, buildInstructions } from '../lib/instructions.ts';
import { loadConfig } from '../lib/config.ts';
import type { HeimdallConfig } from '../lib/config.ts';

const config = loadConfig();

// Typed against the config schema keys so TypeScript enforces that every key in
// HeimdallConfig['tools'] has a corresponding tool here — adding a config key
// without adding the tool (or vice versa) is a compile-time error.
const ALL_TOOLS: Record<keyof HeimdallConfig['tools'], ToolDefinition> = {
  kubectl,
  listContexts,
  listNamespaces,
};

const clusterTools = (Object.keys(ALL_TOOLS) as Array<keyof typeof ALL_TOOLS>)
  .filter((key) => config.tools[key])
  .map((key) => ALL_TOOLS[key]);

if (clusterTools.length === 0) {
  console.warn('[heimdall] No tools are enabled in heimdall.config.yaml — the agent has no cluster access.');
}

const logAnalyzer = defineAgentProfile({
  name: 'log-analyzer',
  description: 'Deep pod-log analysis: error correlation, timeline reconstruction, pattern detection.',
  model: DEFAULT_MODEL,
  instructions: SUBAGENT_INSTRUCTIONS['log-analyzer'],
  tools: clusterTools,
});

const resourceAnalyzer = defineAgentProfile({
  name: 'resource-analyzer',
  description: 'CPU/memory requests & limits, capacity planning, resource bottleneck analysis.',
  model: DEFAULT_MODEL,
  instructions: SUBAGENT_INSTRUCTIONS['resource-analyzer'],
  tools: clusterTools,
});

const networkDebugger = defineAgentProfile({
  name: 'network-debugger',
  description: 'DNS, services, endpoints, ingress, and connectivity troubleshooting.',
  model: DEFAULT_MODEL,
  instructions: SUBAGENT_INSTRUCTIONS['network-debugger'],
  tools: clusterTools,
});

const securityAuditor = defineAgentProfile({
  name: 'security-auditor',
  description: 'RBAC, service accounts, security contexts, and exposed-secret review.',
  model: DEFAULT_MODEL,
  instructions: SUBAGENT_INSTRUCTIONS['security-auditor'],
  tools: clusterTools,
});

export const description = 'Read-only Kubernetes SRE assistant: diagnose cluster issues with kubectl + AI reasoning.';

export default createAgent(() => ({
  model: DEFAULT_MODEL,
  instructions: buildInstructions(),
  tools: clusterTools,
  subagents: [logAnalyzer, resourceAnalyzer, networkDebugger, securityAuditor],
}));
