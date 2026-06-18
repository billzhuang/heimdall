/**
 * Discovery tools: let the agent enumerate clusters and namespaces.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { getContextNames, parseKubeconfig, resolveKubeconfigPath } from '../lib/kubeconfig.ts';
import { runKubectl } from '../lib/kubectl.ts';

export const listContexts = defineTool({
  name: 'list_contexts',
  description:
    'List the Kubernetes cluster contexts available in the kubeconfig, and indicate the current one. ' +
    'Use this to discover which clusters you can target.',
  parameters: v.object({}),
  execute: async () => {
    const path = resolveKubeconfigPath();
    const config = await parseKubeconfig(path);
    if (!config) {
      return `No kubeconfig contexts found at ${path}.`;
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
    // Route through runKubectl so the read-only policy (and any caching) apply
    // uniformly to every cluster read.
    const output = await runKubectl('get namespaces -o jsonpath={.items[*].metadata.name}', { context });
    if (output.startsWith('BLOCKED:') || output.startsWith('kubectl exited')) {
      return output;
    }
    const namespaces = output.trim().split(/\s+/).filter(Boolean);
    if (namespaces.length === 0) {
      return 'No namespaces found (or insufficient permissions to list them).';
    }
    return `Namespaces (${namespaces.length}):\n${namespaces.map((n) => `  ${n}`).join('\n')}`;
  },
});
