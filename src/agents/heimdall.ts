/**
 * Heimdall — an AI-powered, read-only Kubernetes SRE agent.
 *
 * The default export is discovered by Flue as the `heimdall` agent. Talk to it
 * locally with:  `npx flue connect heimdall local`
 *
 * Cluster access flows exclusively through the read-only `kubectl` tool, so the
 * agent can investigate but never mutate a cluster. Deep investigations can be
 * delegated to read-only specialist subagents.
 *
 * Which tools are enabled is controlled by `heimdall.config.yaml` (or the path
 * in `HEIMDALL_CONFIG`), so no code change is needed to add or remove a tool.
 */
import { createAgent, defineAgentProfile } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime';
import { kubectl } from '../tools/kubectl.ts';
import { listContexts, listNamespaces } from '../tools/kubeconfig.ts';
import { DEFAULT_MODEL } from '../lib/model.ts';
import { SUBAGENT_INSTRUCTIONS, buildInstructions } from '../lib/instructions.ts';
import { loadConfig } from '../lib/config.ts';

const config = loadConfig();

const ALL_TOOLS: Record<string, ToolDefinition> = {
  kubectl,
  listContexts,
  listNamespaces,
};

const TOOL_KEYS = ['kubectl', 'listContexts', 'listNamespaces'] as const;

function buildClusterTools(): ToolDefinition[] {
  return TOOL_KEYS.filter((key) => config.tools[key]).map((key) => ALL_TOOLS[key]);
}

const clusterTools = buildClusterTools();

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
