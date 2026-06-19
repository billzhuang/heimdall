/**
 * Heimdall — an AI-powered, read-only Kubernetes SRE agent.
 *
 * The default export is discovered by Flue as the `heimdall` agent. Talk to it
 * locally with:  `npx flue connect heimdall local`
 *
 * Cluster access flows exclusively through the read-only `kubectl` tool, so the
 * agent can investigate but never mutate a cluster. Deep investigations can be
 * delegated to read-only specialist subagents.
 */
import { createAgent, defineAgentProfile } from '@flue/runtime';
import { kubectl } from '../tools/kubectl.ts';
import { listContexts, listNamespaces } from '../tools/kubeconfig.ts';
import { DEFAULT_MODEL } from '../lib/model.ts';
import { SUBAGENT_INSTRUCTIONS, buildInstructions } from '../lib/instructions.ts';

const clusterTools = [kubectl, listContexts, listNamespaces];

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
