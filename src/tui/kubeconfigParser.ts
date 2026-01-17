import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { load as parseYAML } from 'js-yaml';
import { homedir } from 'os';
import { resolve } from 'path';

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
  context: {
    cluster: string;
    user: string;
    namespace?: string;
  };
}

interface RawKubeconfigData {
  contexts?: RawKubeconfigContext[];
  'current-context'?: string;
}

/**
 * Get the default kubeconfig path
 */
export function getDefaultKubeconfigPath(): string {
  return resolve(homedir(), '.kube/config');
}

/**
 * Resolve kubeconfig path from options, environment, or default
 */
export function resolveKubeconfigPath(optionPath?: string): string {
  return optionPath || process.env.KUBECONFIG || getDefaultKubeconfigPath();
}

/**
 * Parse kubeconfig file(s) and extract contexts
 * Supports multiple files separated by : (or ; on Windows)
 */
export async function parseKubeconfig(kubeconfigPath: string): Promise<ParsedKubeconfig | null> {
  try {
    const separator = process.platform === 'win32' ? ';' : ':';
    const paths = kubeconfigPath.includes(separator)
      ? kubeconfigPath.split(separator)
      : [kubeconfigPath];

    const allContexts: KubeconfigContext[] = [];
    let currentContext: string | null = null;

    for (const path of paths) {
      try {
        const content = await readFile(path.trim(), 'utf8');
        const data = parseYAML(content) as RawKubeconfigData;

        if (data.contexts && Array.isArray(data.contexts)) {
          for (const ctx of data.contexts) {
            allContexts.push({
              name: ctx.name,
              cluster: ctx.context.cluster,
              user: ctx.context.user,
              namespace: ctx.context.namespace,
            });
          }
        }

        // Use current-context from first file that defines it
        if (currentContext === null && data['current-context']) {
          currentContext = data['current-context'];
        }
      } catch {
        // Skip files that can't be read, continue with others
        continue;
      }
    }

    if (allContexts.length === 0) {
      return null;
    }

    return {
      contexts: allContexts,
      currentContext,
    };
  } catch {
    return null;
  }
}

/**
 * Parse kubeconfig from raw YAML content (for testing)
 */
export function parseKubeconfigContent(content: string): ParsedKubeconfig | null {
  try {
    const data = parseYAML(content) as RawKubeconfigData;

    if (!data.contexts || !Array.isArray(data.contexts) || data.contexts.length === 0) {
      return null;
    }

    const contexts: KubeconfigContext[] = data.contexts.map(ctx => ({
      name: ctx.name,
      cluster: ctx.context.cluster,
      user: ctx.context.user,
      namespace: ctx.context.namespace,
    }));

    return {
      contexts,
      currentContext: data['current-context'] || null,
    };
  } catch {
    return null;
  }
}

/**
 * Merge multiple kubeconfig data objects
 */
export function mergeKubeconfigs(configs: (ParsedKubeconfig | null)[]): ParsedKubeconfig | null {
  const allContexts: KubeconfigContext[] = [];
  let currentContext: string | null = null;

  for (const config of configs) {
    if (config) {
      allContexts.push(...config.contexts);
      if (currentContext === null && config.currentContext) {
        currentContext = config.currentContext;
      }
    }
  }

  if (allContexts.length === 0) {
    return null;
  }

  return {
    contexts: allContexts,
    currentContext,
  };
}

/**
 * Fetch namespaces from cluster using kubectl
 * Uses execFileSync with argument array to prevent shell injection
 */
export async function fetchNamespaces(
  context: string,
  kubeconfigPath: string
): Promise<string[]> {
  try {
    const args = ['get', 'namespaces', '-o', 'jsonpath={.items[*].metadata.name}'];
    
    // Add context flag if provided
    if (context) {
      args.unshift(`--context=${context}`);
    }

    const env = { ...process.env };
    if (kubeconfigPath) {
      env.KUBECONFIG = kubeconfigPath;
    }

    const output = execFileSync('kubectl', args, { 
      encoding: 'utf8', 
      env, 
      timeout: 10000 
    });
    const namespaces = output.trim().split(/\s+/).filter(Boolean);
    return namespaces;
  } catch {
    return [];
  }
}

/**
 * Get context names from parsed kubeconfig
 */
export function getContextNames(kubeconfig: ParsedKubeconfig): string[] {
  return kubeconfig.contexts.map(ctx => ctx.name);
}
