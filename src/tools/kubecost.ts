/**
 * The `kubecost_query` tool: read-only Kubecost API queries for cost attribution.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { runKubecostQuery, type KubecostConfig } from '../lib/kubecost.ts';
import type { CompiledRedactionRule } from '../lib/regex-redact.ts';
import type { ToolPlugin } from '../lib/plugin.ts';

const DEFAULT_KUBECOST_URL = 'http://kubecost-cost-analyzer.kubecost:9090';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Factory that bakes the Kubecost base URL, timeout, and optional namespace
 * lockdown into the tool closure. URL/credentials are never model-selected.
 */
export function makeKubecostQuery(
  kubecostConfig?: { url?: string | null; timeoutMs?: number | null } | null,
  regexRedactionRules?: CompiledRedactionRule[],
  lockedNamespace?: string | null,
) {
  const config: KubecostConfig = {
    url: kubecostConfig?.url || process.env.KUBECOST_URL || DEFAULT_KUBECOST_URL,
    timeoutMs: kubecostConfig?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    regexRedactionRules,
    lockedNamespace: lockedNamespace ?? undefined,
  };

  const lockdownNote = lockedNamespace
    ? ` NAMESPACE LOCKDOWN ACTIVE: allocation queries are restricted to namespace '${lockedNamespace}'.`
    : '';

  return defineTool({
    name: 'kubecost_query',
    description:
      'Query the Kubecost API for Kubernetes cost attribution (read-only). Two endpoints:\n' +
      '- "allocation": namespace/workload cost breakdown — who is spending what (CPU, memory, storage, network).\n' +
      '  Valid aggregates: namespace, pod, controller, controllerKind, service, node, container, cluster.\n' +
      '- "assets": node/disk infrastructure cost breakdown — underlying cloud resource costs.\n' +
      '  Valid aggregates: account, cluster, project, providerid, provider, type.\n' +
      'Use this to answer FinOps questions: which namespace costs the most, which controller drives cost spikes, ' +
      'and how costs trend over time. The window parameter controls the time range (e.g. "7d", "24h", "30d", "lastweek").' +
      lockdownNote,
    input: v.object({
      endpoint: v.pipe(
        v.picklist(['allocation', 'assets']),
        v.description(
          '"allocation" for namespace/workload cost breakdown; "assets" for node/disk infrastructure costs.',
        ),
      ),
      window: v.pipe(
        v.string(),
        v.description(
          'Time window for the query: duration string (e.g. "7d", "24h", "30d") or named window (e.g. "lastweek", "lastmonth", "yesterday").',
        ),
      ),
      aggregate: v.pipe(
        v.picklist([
          // Allocation API aggregates
          'namespace', 'pod', 'controller', 'controllerKind', 'service', 'node', 'container', 'cluster',
          // Assets API aggregates
          'account', 'project', 'providerid', 'provider', 'type',
        ]),
        v.description(
          'Aggregation dimension. For "allocation": namespace, pod, controller, controllerKind, service, node, container, cluster. ' +
          'For "assets": account, cluster, project, providerid, provider, type.',
        ),
      ),
      namespace: v.pipe(
        v.nullish(v.string()),
        v.description(
          'Filter allocation results to a specific namespace (e.g. "prod"). Omit to query all namespaces. Only applies to the "allocation" endpoint.',
        ),
      ),
      accumulate: v.pipe(
        v.nullish(v.boolean()),
        v.description(
          'When true (default), returns a single accumulated total for the window. When false, returns time-series buckets.',
        ),
      ),
    }),
    run: async ({ input: { endpoint, window, aggregate, namespace, accumulate } }) =>
      runKubecostQuery(endpoint, { window, aggregate, namespace, accumulate }, config),
  });
}

export const kubecostPlugin: ToolPlugin = {
  key: 'kubecostQuery',
  factory: (config, rules) => makeKubecostQuery(config.kubecost, rules, config.namespace?.locked),
};
