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
export type KubecostAggregate = 'namespace' | 'pod' | 'deployment' | 'controller' | 'service' | 'node';

export interface KubecostQueryParams {
  window: string;
  aggregate: KubecostAggregate;
  namespace?: string;
  accumulate?: boolean;
}

const ENDPOINT_PATH: Record<KubecostEndpoint, string> = {
  allocation: '/model/allocation',
  assets: '/model/assets',
};

/**
 * Execute a read-only Kubecost query and return the JSON response as a string.
 *
 * Validates required params, applies a request timeout, and caps output to
 * avoid blowing the model's context window.
 */
export async function runKubecostQuery(
  endpoint: KubecostEndpoint,
  params: KubecostQueryParams,
  config: KubecostConfig,
): Promise<string> {
  if (!params.window) return 'Error: window is required (e.g. "7d", "24h", "1w").';
  if (!params.aggregate) return 'Error: aggregate is required (namespace/pod/deployment/controller/service/node).';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const baseUrl = new URL(config.url);
    baseUrl.pathname = baseUrl.pathname.replace(/\/$/, '') + ENDPOINT_PATH[endpoint];

    baseUrl.searchParams.set('window', params.window);
    baseUrl.searchParams.set('aggregate', params.aggregate);
    baseUrl.searchParams.set('accumulate', String(params.accumulate ?? true));

    if (endpoint === 'allocation' && params.namespace) {
      baseUrl.searchParams.set('filterNamespaces', params.namespace);
    }

    const response = await fetch(baseUrl.toString(), { signal: controller.signal });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const detail = body ? `: ${body.slice(0, 200)}` : '';
      return `Kubecost HTTP ${response.status} ${response.statusText}${detail}`;
    }

    const text = await response.text();
    return truncate(applyRedaction(text, config.regexRedactionRules ?? []));
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return `Kubecost query timed out after ${config.timeoutMs}ms.`;
    }
    return `Kubecost query failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    clearTimeout(timer);
  }
}
