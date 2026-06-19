/**
 * Reads kubeconfig metadata so the agent can discover which clusters and
 * namespaces are available. Parsing is pure and tested; namespace listing
 * shells out to kubectl (read-only).
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { load as parseYAML } from 'js-yaml';

export interface KubeconfigContext {
  name: string;
  cluster: string;
  user: string;
  namespace?: string;
}

export interface ParsedKubeconfig {
  contexts: KubeconfigContext[];
  currentContext: string | null;
}

interface RawKubeconfigContext {
  name: string;
  context: { cluster: string; user: string; namespace?: string };
}

interface RawKubeconfigData {
  contexts?: RawKubeconfigContext[];
  'current-context'?: string;
}

/** Default `~/.kube/config` path. */
export function getDefaultKubeconfigPath(): string {
  return resolve(homedir(), '.kube/config');
}

/** Resolve the kubeconfig path from an explicit value, `KUBECONFIG`, or the default. */
export function resolveKubeconfigPath(optionPath?: string): string {
  return optionPath || process.env.KUBECONFIG || getDefaultKubeconfigPath();
}

/** Context name used when Heimdall detects it is running inside a Kubernetes pod. */
export const IN_CLUSTER_CONTEXT = 'in-cluster';

/**
 * True when the process is running inside a Kubernetes pod.
 * kubectl automatically reads the mounted service account token in this case —
 * no kubeconfig file or --context flag is needed.
 */
export function isInCluster(): boolean {
  return !!process.env.KUBERNETES_SERVICE_HOST;
}

/** Synthetic single-context kubeconfig representing the pod's own cluster. */
export function inClusterConfig(): ParsedKubeconfig {
  return {
    contexts: [{ name: IN_CLUSTER_CONTEXT, cluster: IN_CLUSTER_CONTEXT, user: IN_CLUSTER_CONTEXT }],
    currentContext: IN_CLUSTER_CONTEXT,
  };
}

/** Parse kubeconfig YAML content into contexts. Pure — used by tests. */
export function parseKubeconfigContent(content: string): ParsedKubeconfig | null {
  try {
    const data = parseYAML(content) as RawKubeconfigData;
    if (!data.contexts || !Array.isArray(data.contexts) || data.contexts.length === 0) {
      return null;
    }
    const contexts: KubeconfigContext[] = data.contexts.map((ctx) => ({
      name: ctx.name,
      cluster: ctx.context.cluster,
      user: ctx.context.user,
      namespace: ctx.context.namespace,
    }));
    return { contexts, currentContext: data['current-context'] || null };
  } catch {
    return null;
  }
}

/**
 * Merge multiple parsed kubeconfigs; the first non-null current-context wins.
 * Context names are deduplicated (first occurrence wins), matching kubectl's
 * behavior when the same name appears across merged files.
 */
export function mergeKubeconfigs(configs: (ParsedKubeconfig | null)[]): ParsedKubeconfig | null {
  const allContexts: KubeconfigContext[] = [];
  const seen = new Set<string>();
  let currentContext: string | null = null;
  for (const config of configs) {
    if (!config) continue;
    for (const ctx of config.contexts) {
      if (seen.has(ctx.name)) continue;
      seen.add(ctx.name);
      allContexts.push(ctx);
    }
    if (currentContext === null && config.currentContext) {
      currentContext = config.currentContext;
    }
  }
  return allContexts.length === 0 ? null : { contexts: allContexts, currentContext };
}

/** Get the list of context names from a parsed kubeconfig. */
export function getContextNames(kubeconfig: ParsedKubeconfig): string[] {
  return kubeconfig.contexts.map((ctx) => ctx.name);
}

/**
 * Parse one or more kubeconfig files (path may contain the platform separator,
 * e.g. `a:b` on POSIX). Unreadable files are skipped.
 */
export async function parseKubeconfig(kubeconfigPath: string): Promise<ParsedKubeconfig | null> {
  const separator = process.platform === 'win32' ? ';' : ':';
  const paths = kubeconfigPath.includes(separator) ? kubeconfigPath.split(separator) : [kubeconfigPath];

  const parsed: (ParsedKubeconfig | null)[] = [];
  for (const path of paths) {
    try {
      const content = await readFile(path.trim(), 'utf8');
      parsed.push(parseKubeconfigContent(content));
    } catch {
      parsed.push(null);
    }
  }
  return mergeKubeconfigs(parsed);
}
