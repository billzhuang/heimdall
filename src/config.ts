import { homedir } from "os";
import { resolve } from "path";

export interface HeimdallConfig {
  cluster: string;
  kubeconfig: string;
  context?: string;
  namespace: string;
}

export function loadConfig(options: {
  cluster: string;
  kubeconfig?: string;
  context?: string;
  namespace?: string;
}): HeimdallConfig {
  const defaultKubeconfig = resolve(
    process.env.KUBECONFIG || `${homedir()}/.kube/config`
  );

  return {
    cluster: options.cluster || process.env.HEIMDALL_CLUSTER || "",
    kubeconfig: options.kubeconfig || defaultKubeconfig,
    context: options.context || process.env.K8S_CONTEXT,
    namespace: options.namespace || "all",
  };
}

export function validateConfig(config: HeimdallConfig): void {
  if (!config.cluster) {
    throw new Error(
      "Cluster name is required. Use --cluster or set HEIMDALL_CLUSTER environment variable."
    );
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is required. Get your key from https://console.anthropic.com/"
    );
  }
}
