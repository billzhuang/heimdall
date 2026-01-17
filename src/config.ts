import { homedir } from "os";
import { resolve } from "path";

export interface HeimdallConfig {
  kubeconfig: string;
  context: string;
  namespace: string;
}

export function loadConfig(options: {
  kubeconfig?: string;
  context: string;
  namespace?: string;
}): HeimdallConfig {
  const defaultKubeconfig = resolve(
    process.env.KUBECONFIG || `${homedir()}/.kube/config`
  );

  return {
    kubeconfig: options.kubeconfig || defaultKubeconfig,
    context: options.context,
    namespace: options.namespace || "all",
  };
}

export function validateConfig(config: HeimdallConfig): void {
  if (!config.context) {
    throw new Error("Kubernetes context is required.");
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is required. Get your key from https://console.anthropic.com/"
    );
  }
}
