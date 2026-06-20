/**
 * Pure HTTP helpers for Kubecost REST API access.
 *
 * Supports allocation queries (/model/allocation) for namespace/workload cost
 * breakdown and asset queries (/model/assets) for node/disk infrastructure costs.
 * The Kubecost base URL and timeout come from trusted config/env — never from
 * model-selected arguments.
 */
import { applyRedaction, type CompiledRedactionRule } from './regex-redact.ts';

export interface KubecostConfig {
  url: string;
  timeoutMs: number;
  regexRedactionRules?: CompiledRedactionRule[];
  /** When set, all allocation queries are restricted to this namespace (code-enforced). */
  lockedNamespace?: string;
}

const MAX_RESULT_CHARS = 20_000;

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS) +
    '\n\n[Output truncated — use a shorter window, fewer namespaces, or a coarser aggregate]'
  );
}

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

  // Namespace lockdown: code-enforced when config.lockedNamespace is set.
  // For allocation queries, override filterNamespaces with the locked value.
  // Block if the caller explicitly passes a different namespace.
  let effectiveNamespace: string | undefined;
  if (endpoint === 'allocation') {
    if (config.lockedNamespace) {
      if (params.namespace != null && params.namespace !== config.lockedNamespace) {
        return `BLOCKED: namespace lockdown is active — queries are restricted to namespace '${config.lockedNamespace}'. Remove the namespace parameter or set it to '${config.lockedNamespace}'.`;
      }
      effectiveNamespace = config.lockedNamespace;
    } else {
      effectiveNamespace = params.namespace ?? undefined;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const baseUrl = new URL(config.url);
    baseUrl.pathname = baseUrl.pathname.replace(/\/$/, '') + ENDPOINT_PATH[endpoint];

    baseUrl.searchParams.set('window', params.window);
    baseUrl.searchParams.set('aggregate', params.aggregate);
    baseUrl.searchParams.set('accumulate', String(params.accumulate ?? true));

    if (effectiveNamespace) {
      baseUrl.searchParams.set('filterNamespaces', effectiveNamespace);
    }

    const response = await fetch(baseUrl.toString(), { signal: controller.signal });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const redactedBody = applyRedaction(body, config.regexRedactionRules ?? []);
      const detail = redactedBody ? `: ${redactedBody.slice(0, 200)}` : '';
      return `Kubecost HTTP ${response.status} ${response.statusText}${detail}`;
    }

    const text = await response.text();
    return truncate(applyRedaction(text, config.regexRedactionRules ?? []));
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return `Kubecost query timed out after ${config.timeoutMs}ms.`;
    }
    const message = err instanceof Error ? err.message : String(err);
    return `Kubecost query failed: ${applyRedaction(message, config.regexRedactionRules ?? [])}`;
  } finally {
    clearTimeout(timer);
  }
}
