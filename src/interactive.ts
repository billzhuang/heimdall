import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { load as parseYAML } from "js-yaml";
import { homedir } from "os";
import { resolve } from "path";
import { MODEL_MAP } from "./constants.js";

// Colors for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
};

interface KubeconfigContext {
  name: string;
  context: {
    cluster: string;
    user: string;
    namespace?: string;
  };
}

interface KubeconfigData {
  contexts: KubeconfigContext[];
  "current-context"?: string;
}

export interface CLIOptions {
  cluster?: string;
  context?: string;
  namespace?: string;
  kubeconfig?: string;
  model?: string;
  mode?: string;
  verbose?: boolean;
  interactive?: boolean;
  interactiveTranscript?: string;
}

async function parseKubeconfig(
  kubeconfigPath: string,
): Promise<KubeconfigData | null> {
  try {
    // KUBECONFIG can contain multiple paths separated by : (or ; on Windows)
    const separator = process.platform === "win32" ? ";" : ":";
    const paths = kubeconfigPath.includes(separator)
      ? kubeconfigPath.split(separator)
      : [kubeconfigPath];

    let allContexts: KubeconfigContext[] = [];
    let currentContext: string | undefined;

    // Try to parse each kubeconfig file
    for (const path of paths) {
      try {
        const content = await readFile(path.trim(), "utf8");
        const data = parseYAML(content) as KubeconfigData;

        if (data.contexts && Array.isArray(data.contexts)) {
          allContexts = allContexts.concat(data.contexts);
        }

        // Use the current-context from the first file that has one
        if (!currentContext && data["current-context"]) {
          currentContext = data["current-context"];
        }
      } catch (error) {
        // Skip files that can't be read, continue with others
        continue;
      }
    }

    if (allContexts.length === 0) {
      return null;
    }

    return {
      contexts: allContexts,
      "current-context": currentContext,
    };
  } catch (error) {
    return null;
  }
}

async function promptForContext(
  contexts: string[],
  currentContext?: string,
): Promise<string> {
  const rl = createInterface({ input, output });

  try {
    console.log(`${colors.cyan}${colors.bright}\nAvailable contexts:${colors.reset}`);

    contexts.forEach((ctx, index) => {
      const current = ctx === currentContext ? " [current]" : "";
      const displayName = ctx.length > 80 ? ctx.substring(0, 77) + "..." : ctx;
      console.log(
        `${colors.dim}  ${index + 1}. ${displayName}${current}${colors.reset}`,
      );
    });

    while (true) {
      const answer = (
        await rl.question(
          `\n${colors.green}? Select context (enter number or press Enter for current):${colors.reset} `,
        )
      ).trim();

      // Empty input means use current context
      if (!answer && currentContext) {
        rl.close();
        return currentContext;
      }

      const choice = parseInt(answer, 10);
      if (choice >= 1 && choice <= contexts.length) {
        rl.close();
        return contexts[choice - 1];
      }

      console.log(
        `${colors.yellow}Invalid choice. Please enter a number between 1 and ${contexts.length}.${colors.reset}`,
      );
    }
  } catch (error) {
    rl.close();
    throw error;
  }
}

async function promptForManualContext(): Promise<string> {
  const rl = createInterface({ input, output });

  try {
    while (true) {
      const answer = (
        await rl.question(
          `${colors.green}? Enter Kubernetes context name:${colors.reset} `,
        )
      ).trim();

      if (answer) {
        rl.close();
        return answer;
      }

      console.log(
        `${colors.yellow}Context name is required.${colors.reset}`,
      );
    }
  } catch (error) {
    rl.close();
    throw error;
  }
}

async function promptForClusterName(): Promise<string> {
  const rl = createInterface({ input, output });

  try {
    while (true) {
      const answer = (
        await rl.question(
          `${colors.green}? Enter cluster name:${colors.reset} `,
        )
      ).trim();

      if (answer) {
        rl.close();
        return answer;
      }

      console.log(
        `${colors.yellow}Cluster name is required.${colors.reset}`,
      );
    }
  } catch (error) {
    rl.close();
    throw error;
  }
}

async function promptForNamespace(
  context?: string,
  kubeconfigPath?: string,
): Promise<string> {
  const rl = createInterface({ input, output });

  try {
    console.log(`${colors.cyan}\nNamespace to check:${colors.reset}`);
    console.log(`${colors.dim}  1. All namespaces${colors.reset}`);
    console.log(`${colors.dim}  2. Select from available namespaces${colors.reset}`);
    console.log(`${colors.dim}  3. Type a specific namespace${colors.reset}`);

    while (true) {
      const answer = (
        await rl.question(
          `${colors.green}? Select option (1-3):${colors.reset} [1] `,
        )
      ).trim();

      // Default to all namespaces (option 1)
      if (!answer || answer === "1") {
        rl.close();
        return "all";
      }

      if (answer === "2") {
        // List namespaces using kubectl
        try {
          const { execSync } = await import("child_process");
          const contextFlag = context ? `--context=${context}` : "";
          const kubeconfigFlag = kubeconfigPath
            ? `--kubeconfig=${kubeconfigPath.split(":")[0]}`
            : "";
          const cmd = `kubectl ${contextFlag} ${kubeconfigFlag} get namespaces -o jsonpath='{.items[*].metadata.name}'`.trim();

          const output = execSync(cmd, { encoding: "utf8" });
          const namespaces = output.trim().split(/\s+/).filter(Boolean);

          if (namespaces.length === 0) {
            console.log(
              `${colors.yellow}No namespaces found. Please type manually.${colors.reset}`,
            );
            continue;
          }

          console.log(
            `${colors.cyan}\nAvailable namespaces:${colors.reset}`,
          );
          namespaces.forEach((ns, index) => {
            console.log(`${colors.dim}  ${index + 1}. ${ns}${colors.reset}`);
          });

          while (true) {
            const nsAnswer = (
              await rl.question(
                `${colors.green}? Select namespace (1-${namespaces.length}):${colors.reset} `,
              )
            ).trim();

            const choice = parseInt(nsAnswer, 10);
            if (choice >= 1 && choice <= namespaces.length) {
              rl.close();
              return namespaces[choice - 1];
            }

            console.log(
              `${colors.yellow}Invalid choice. Please enter a number between 1 and ${namespaces.length}.${colors.reset}`,
            );
          }
        } catch (error) {
          console.log(
            `${colors.yellow}⚠️  Could not list namespaces (kubectl may not be accessible)${colors.reset}`,
          );
          console.log(
            `${colors.dim}   Falling back to manual entry.${colors.reset}\n`,
          );
          // Fall through to option 3
        }
      }

      if (answer === "3" || answer === "2") {
        // Prompt for specific namespace
        const namespace = (
          await rl.question(
            `${colors.green}? Enter namespace name:${colors.reset} `,
          )
        ).trim();

        if (namespace) {
          rl.close();
          return namespace;
        }

        console.log(
          `${colors.yellow}Namespace name is required.${colors.reset}`,
        );
        continue;
      }

      console.log(
        `${colors.yellow}Invalid choice. Please enter 1, 2, or 3.${colors.reset}`,
      );
    }
  } catch (error) {
    rl.close();
    throw error;
  }
}

async function promptForMode(): Promise<string> {
  const rl = createInterface({ input, output });

  const modes = [
    {
      value: "smoke",
      label: "Smoke - Quick health check",
      description:
        "Node health, critical pod failures, recent warning events (~30s)",
    },
    {
      value: "all",
      label: "All - Comprehensive check",
      description:
        "All 10 categories: nodes, pods, deployments, services, events, helm, configs, storage, jobs (~2-3min)",
    },
  ];

  try {
    console.log(`${colors.cyan}\nHealth check mode:${colors.reset}`);
    modes.forEach((mode, index) => {
      console.log(`${colors.dim}  ${index + 1}. ${mode.label}${colors.reset}`);
      console.log(`${colors.dim}     ${mode.description}${colors.reset}`);
    });

    while (true) {
      const answer = (
        await rl.question(
          `${colors.green}? Select mode (1-${modes.length}):${colors.reset} [1] `,
        )
      ).trim();

      // Default to smoke (option 1)
      if (!answer) {
        rl.close();
        return "smoke";
      }

      const choice = parseInt(answer, 10);
      if (choice >= 1 && choice <= modes.length) {
        rl.close();
        return modes[choice - 1].value;
      }

      console.log(
        `${colors.yellow}Invalid choice. Please enter 1 or 2.${colors.reset}`,
      );
    }
  } catch (error) {
    rl.close();
    throw error;
  }
}

async function promptForModel(): Promise<string> {
  const rl = createInterface({ input, output });

  const models = Object.keys(MODEL_MAP).map((key) => ({
    shorthand: key,
    label: MODEL_MAP[key].label,
    id: MODEL_MAP[key].id,
  }));

  try {
    console.log(`${colors.cyan}\nAvailable models:${colors.reset}`);
    models.forEach((model, index) => {
      console.log(`${colors.dim}  ${index + 1}. ${model.label}${colors.reset}`);
    });

    while (true) {
      const answer = (
        await rl.question(
          `${colors.green}? Select model (1-${models.length}):${colors.reset} [1] `,
        )
      ).trim();

      // Default to sonnet (option 1)
      if (!answer) {
        rl.close();
        return "sonnet";
      }

      const choice = parseInt(answer, 10);
      if (choice >= 1 && choice <= models.length) {
        rl.close();
        return models[choice - 1].shorthand;
      }

      console.log(
        `${colors.yellow}Invalid choice. Please enter a number between 1 and ${models.length}.${colors.reset}`,
      );
    }
  } catch (error) {
    rl.close();
    throw error;
  }
}

export async function promptForMissingParams(
  options: CLIOptions,
): Promise<CLIOptions> {
  // Check if we're in a TTY environment
  // isTTY is true when running in an interactive terminal, false/undefined otherwise
  if (!process.stdin.isTTY) {
    throw new Error(
      "Interactive mode requires a terminal. Please provide --cluster, --context, and other required flags.",
    );
  }

  console.log(`${colors.cyan}${colors.bright}Welcome to Heimdall - EKS Health Check Agent${colors.reset}\n`);
  console.log("No cluster specified. Let's configure your health check interactively.\n");

  const finalOptions: CLIOptions = { ...options };

  // Determine kubeconfig path
  const kubeconfigPath = options.kubeconfig ||
    process.env.KUBECONFIG ||
    resolve(homedir(), ".kube/config");

  console.log(`${colors.dim}📁 Kubeconfig: ${kubeconfigPath}${colors.reset}`);

  // Prompt for context if not provided
  if (!finalOptions.context) {
    const kubeconfigData = await parseKubeconfig(kubeconfigPath);

    if (kubeconfigData && kubeconfigData.contexts.length > 0) {
      const contextNames = kubeconfigData.contexts.map((ctx) => ctx.name);
      const currentContext = kubeconfigData["current-context"];

      finalOptions.context = await promptForContext(contextNames, currentContext);
    } else {
      console.log(
        `${colors.yellow}⚠️  Could not parse kubeconfig at ${kubeconfigPath}${colors.reset}`,
      );
      console.log(`${colors.dim}   Falling back to manual context entry.${colors.reset}\n`);

      finalOptions.context = await promptForManualContext();
    }
  }

  // Prompt for cluster name if not provided
  if (!finalOptions.cluster) {
    finalOptions.cluster = await promptForClusterName();
  }

  // Prompt for namespace if not provided
  if (!finalOptions.namespace) {
    finalOptions.namespace = await promptForNamespace(
      finalOptions.context,
      kubeconfigPath,
    );
  }

  // Prompt for mode if not provided
  if (!finalOptions.mode) {
    finalOptions.mode = await promptForMode();
  }

  // Prompt for model if not provided
  if (!finalOptions.model) {
    finalOptions.model = await promptForModel();
  }

  console.log(); // Empty line for spacing

  return finalOptions;
}
