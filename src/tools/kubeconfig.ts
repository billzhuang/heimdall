/**
 * Discovery tools: let the agent enumerate clusters and namespaces.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
  IN_CLUSTER_CONTEXT,
  getContextNames,
  isInCluster,
  parseKubeconfig,
  resolveKubeconfigPath,
} from '../lib/kubeconfig.ts';
import { NO_OUTPUT_MESSAGE, runKubectl } from '../lib/kubectl.ts';

export const listContexts = defineTool({
  name: 'list_contexts',
  description:
    'List the Kubernetes cluster contexts available in the kubeconfig, and indicate the current one. ' +
    'Use this to discover which clusters you can target.',
  parameters: v.object({}),
  execute: async () => {
    // In-cluster: kubectl reads the pod's service account token automatically.
    if (isInCluster()) {
      return `Contexts (1):\n* ${IN_CLUSTER_CONTEXT} (current)`;
    }

    const kubeconfigPath = resolveKubeconfigPath();

    const config = await parseKubeconfig(kubeconfigPath);
    if (!config) {
      return `No kubeconfig contexts found at ${kubeconfigPath}.`;
    }
    const names = getContextNames(config);
    const lines = names.map((name) =>
      name === config.currentContext ? `* ${name} (current)` : `  ${name}`,
    );
    return `Contexts (${names.length}):\n${lines.join('\n')}`;
  },
});

export const listNamespaces = defineTool({
  name: 'list_namespaces',
  description: 'List the namespaces in a cluster context. Defaults to the current/configured context.',
  parameters: v.object({
    context: v.pipe(
      v.optional(v.string()),
      v.description('Cluster context to query. Defaults to the configured/current context.'),
    ),
  }),
  execute: async ({ context }) => {
    // In-cluster: there is only one cluster (the pod's own). Context is not applicable.
    const effectiveContext = isInCluster() ? undefined : context;
    const output = (await runKubectl('get namespaces -o jsonpath={.items[*].metadata.name}', { context: effectiveContext })).trim();
    // Surface policy/execution errors verbatim rather than parsing them as data.
    if (output.startsWith('BLOCKED:') || output.startsWith('kubectl exited')) {
      return output;
    }
    const empty = 'No namespaces found (or insufficient permissions to list them).';
    if (output === NO_OUTPUT_MESSAGE) {
      return empty;
    }
    const namespaces = output.split(/\s+/).filter(Boolean);
    if (namespaces.length === 0) {
      return empty;
    }
    return `Namespaces (${namespaces.length}):\n${namespaces.map((n) => `  ${n}`).join('\n')}`;
  },
});
