/**
 * Reads kubeconfig metadata so the agent can discover which clusters and
 * namespaces are available. Parsing is pure and tested; namespace listing
 * shells out to kubectl (read-only).
 */
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { load as parseYAML } from 'js-yaml';

const execFileAsync = promisify(execFile);

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

/** Merge multiple parsed kubeconfigs; the first non-null current-context wins. */
export function mergeKubeconfigs(configs: (ParsedKubeconfig | null)[]): ParsedKubeconfig | null {
  const allContexts: KubeconfigContext[] = [];
  let currentContext: string | null = null;
  for (const config of configs) {
    if (!config) continue;
    allContexts.push(...config.contexts);
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

/**
 * Fetch namespace names from the cluster. Uses `execFile` with an argument
 * array (no shell) to keep it injection-safe.
 */
export async function fetchNamespaces(context: string, kubeconfigPath?: string): Promise<string[]> {
  const args = ['get', 'namespaces', '-o', 'jsonpath={.items[*].metadata.name}'];
  if (context) {
    args.unshift(`--context=${context}`);
  }

  const env = { ...process.env };
  if (kubeconfigPath) {
    env.KUBECONFIG = kubeconfigPath;
  }

  const { stdout } = await execFileAsync('kubectl', args, { encoding: 'utf8', env, timeout: 10_000 });
  return stdout.trim().split(/\s+/).filter(Boolean);
}
