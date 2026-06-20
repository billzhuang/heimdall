/**
 * The `kubecost_query` tool: read-only Kubecost API queries for cost attribution.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { runKubecostQuery, type KubecostConfig } from '../lib/kubecost.ts';
import type { CompiledRedactionRule } from '../lib/regex-redact.ts';

const DEFAULT_KUBECOST_URL = 'http://kubecost-cost-analyzer.kubecost:9090';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Factory that bakes the Kubecost base URL and timeout into the tool closure.
 * The URL is resolved from config → env → in-cluster default, never from the model.
 */
export function makeKubecostQuery(
  kubecostConfig?: { url?: string | null; timeoutMs?: number | null } | null,
  regexRedactionRules?: CompiledRedactionRule[],
) {
  const config: KubecostConfig = {
    url: kubecostConfig?.url || process.env.KUBECOST_URL || DEFAULT_KUBECOST_URL,
    timeoutMs: kubecostConfig?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    regexRedactionRules,
  };

  return defineTool({
    name: 'kubecost_query',
    description:
      'Query the Kubecost API for Kubernetes cost attribution (read-only). Two endpoints:\n' +
      '- "allocation": namespace/workload cost breakdown — who is spending what (CPU, memory, storage, network).\n' +
      '- "assets": node/disk infrastructure cost breakdown — underlying cloud resource costs.\n' +
      'Use this to answer FinOps questions: which namespace costs the most, which deployment drives cost spikes, ' +
      'and how costs trend over time. The window parameter controls the time range (e.g. "7d", "24h", "30d", "lastweek").',
    parameters: v.object({
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
        v.picklist(['namespace', 'pod', 'deployment', 'controller', 'service', 'node']),
        v.description(
          'Aggregation dimension: "namespace" for per-namespace totals, "deployment" for per-deployment breakdown, ' +
          '"pod" for individual pod costs, "controller" for controller-level rollups, "service" for per-service, "node" for per-node.',
        ),
      ),
      namespace: v.pipe(
        v.optional(v.string()),
        v.description(
          'Filter allocation results to a specific namespace (e.g. "prod"). Omit to query all namespaces. Only applies to the "allocation" endpoint.',
        ),
      ),
      accumulate: v.pipe(
        v.optional(v.boolean()),
        v.description(
          'When true (default), returns a single accumulated total for the window. When false, returns time-series buckets.',
        ),
      ),
    }),
    execute: async ({ endpoint, window, aggregate, namespace, accumulate }) =>
      runKubecostQuery(endpoint, { window, aggregate, namespace, accumulate }, config),
  });
}
