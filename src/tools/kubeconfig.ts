/**
 * Discovery tools: let the agent enumerate clusters and namespaces.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type { ToolPlugin } from '../lib/plugin.ts';
import {
  IN_CLUSTER_CONTEXT,
  getContextNames,
  isInCluster,
  parseKubeconfig,
  resolveKubeconfigPath,
} from '../lib/kubeconfig.ts';
import { NO_OUTPUT_MESSAGE, runKubectl } from '../lib/kubectl.ts';
import { BLOCKED_PREFIX } from '../lib/harness.ts';
import { buildLockdownNote } from '../lib/tool-config.ts';

/**
 * Format a labeled, counted list for tool output: "Label (N):\n" followed by
 * one line per item, `* item (current)` when `isCurrent` matches or `  item`
 * otherwise. Shared by list_contexts and list_namespaces, which both render
 * this "count header + marked lines" shape.
 */
function formatCountedList(
  label: string,
  items: string[],
  isCurrent?: (item: string) => boolean,
): string {
  const lines = items.map((item) => (isCurrent?.(item) ? `* ${item} (current)` : `  ${item}`));
  return `${label} (${items.length}):\n${lines.join('\n')}`;
}

export const listContexts = defineTool({
  name: 'list_contexts',
  description:
    'List the Kubernetes cluster contexts available in the kubeconfig, and indicate the current one. ' +
    'Use this to discover which clusters you can target.',
  input: v.object({}),
  run: async () => {
    // In-cluster: kubectl reads the pod's service account token automatically.
    if (isInCluster()) {
      return formatCountedList('Contexts', [IN_CLUSTER_CONTEXT], () => true);
    }

    const kubeconfigPath = resolveKubeconfigPath();

    const config = await parseKubeconfig(kubeconfigPath);
    if (!config) {
      return `No kubeconfig contexts found at ${kubeconfigPath}.`;
    }
    const names = getContextNames(config);
    return formatCountedList('Contexts', names, (name) => name === config.currentContext);
  },
});

export function makeListNamespaces(lockedNamespace?: string | null) {
  const lockdownNote = buildLockdownNote(lockedNamespace, (ns) => `only namespace '${ns}' is accessible.`);
  return defineTool({
    name: 'list_namespaces',
    description:
      'List the namespaces in a cluster context. Defaults to the current/configured context.' + lockdownNote,
    input: v.object({
      context: v.pipe(
        v.optional(v.string()),
        v.description('Cluster context to query. Defaults to the configured/current context.'),
      ),
    }),
    run: async ({ input: { context } }) => {
      // When lockdown is active, return only the locked namespace without
      // querying the cluster (which would list all namespaces).
      if (lockedNamespace) {
        return formatCountedList('Namespaces', [lockedNamespace]);
      }
      const output = (await runKubectl('get namespaces -o jsonpath={.items[*].metadata.name}', { context })).trim();
      // Surface policy/execution errors verbatim rather than parsing them as data.
      if (output.startsWith(BLOCKED_PREFIX) || output.startsWith('kubectl exited')) {
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
      return formatCountedList('Namespaces', namespaces);
    },
  });
}

export const listNamespaces = makeListNamespaces();

export const listContextsPlugin: ToolPlugin = {
  key: 'listContexts',
  factory: () => listContexts,
};

export const listNamespacesPlugin: ToolPlugin = {
  key: 'listNamespaces',
  factory: (config) => makeListNamespaces(config.namespace?.locked),
};
