/**
 * Pure HTTP helpers for Kubecost REST API access.
 *
 * Supports allocation queries (/model/allocation) for namespace/workload cost
 * breakdown and asset queries (/model/assets) for node/disk infrastructure costs.
 * The Kubecost base URL and timeout come from trusted config/env — never from
 * model-selected arguments.
 */
import type { CompiledRedactionRule } from './regex-redact.ts';
import { makeTruncate } from './output-truncation.ts';
import { runJsonQuery } from './http.ts';

export interface KubecostConfig {
  url: string;
  timeoutMs: number;
  regexRedactionRules?: CompiledRedactionRule[];
  /** When set, all allocation queries are restricted to this namespace (code-enforced). */
  lockedNamespace?: string;
}

const MAX_RESULT_CHARS = 20_000;
const truncate = makeTruncate(MAX_RESULT_CHARS, 'use a shorter window, fewer namespaces, or a coarser aggregate');

export type KubecostEndpoint = 'allocation' | 'assets';

/**
 * Valid aggregates for the Allocation API: cluster, node, namespace,
 * controllerKind, controller, service, pod, container.
 * Valid aggregates for the Assets API: account, cluster, project,
 * providerid, provider, type.
 */
export type KubecostAggregate =
  | 'namespace' | 'pod' | 'controller' | 'controllerKind' | 'service'
  | 'node' | 'container' | 'cluster'
  | 'account' | 'project' | 'providerid' | 'provider' | 'type';

export interface KubecostQueryParams {
  window: string;
  aggregate: KubecostAggregate;
  namespace?: string | null;
  accumulate?: boolean | null;
}

const ENDPOINT_PATH: Record<KubecostEndpoint, string> = {
  allocation: '/model/allocation',
  assets: '/model/assets',
};

/** Result of {@link resolveAllocationNamespace}: either the namespace to query, or a blocked-response message. */
export type AllocationNamespaceResolution =
  | { namespace: string | undefined }
  | { blockedMessage: string };

/**
 * Resolve the `filterNamespaces` value for an allocation query, applying
 * namespace lockdown when configured.
 *
 * When no namespace is locked, the caller-requested namespace passes through
 * unchanged. When locked, the locked namespace is used unless the caller
 * explicitly requests a different, non-null namespace — in which case the
 * query is blocked.
 */
export function resolveAllocationNamespace(
  requested: string | null | undefined,
  lockedNamespace: string | undefined,
): AllocationNamespaceResolution {
  if (!lockedNamespace) return { namespace: requested ?? undefined };
  if (requested != null && requested !== lockedNamespace) {
    return {
      blockedMessage: `BLOCKED: namespace lockdown is active — queries are restricted to namespace '${lockedNamespace}'. Remove the namespace parameter or set it to '${lockedNamespace}'.`,
    };
  }
  return { namespace: lockedNamespace };
}

/**
 * Execute a read-only Kubecost query and return the JSON response as a string.
 *
 * Validates required params, enforces namespace lockdown when configured,
 * applies a request timeout, and caps output to avoid blowing the model's
 * context window.
 */
export async function runKubecostQuery(
  endpoint: KubecostEndpoint,
  params: KubecostQueryParams,
  config: KubecostConfig,
): Promise<string> {
  if (!params.window) return 'Error: window is required (e.g. "7d", "24h", "1w").';

  if (endpoint === 'assets' && params.namespace != null) {
    return 'Error: the "namespace" filter only applies to allocation queries, not to assets queries. Omit namespace and re-run, or use endpoint "allocation" instead.';
  }

  // For allocation queries, resolve the effective namespace under lockdown.
  let effectiveNamespace: string | undefined;
  if (endpoint === 'allocation') {
    const resolved = resolveAllocationNamespace(params.namespace, config.lockedNamespace);
    if ('blockedMessage' in resolved) return resolved.blockedMessage;
    effectiveNamespace = resolved.namespace;
  }

  return runJsonQuery(config, ENDPOINT_PATH[endpoint], 'Kubecost', truncate, (searchParams) => {
    searchParams.set('window', params.window);
    searchParams.set('aggregate', params.aggregate);
    searchParams.set('accumulate', String(params.accumulate ?? true));

    if (effectiveNamespace) {
      searchParams.set('filterNamespaces', effectiveNamespace);
    }
  });
}
