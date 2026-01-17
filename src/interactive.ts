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
  kubeconfig?: string;
  verbose?: boolean;
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
          const cmd = `kubectl ${contextFlag} get namespaces -o jsonpath='{.items[*].metadata.name}'`.trim();

          // Set KUBECONFIG env var to support multiple config files
          const env = { ...process.env };
          if (kubeconfigPath) {
            env.KUBECONFIG = kubeconfigPath;
          }

          const output = execSync(cmd, { encoding: "utf8", env });
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

export interface ParsedCommand {
  action: 'check' | 'help' | 'exit' | 'unknown';
  mode?: 'smoke' | 'all';
  model?: string;
  rawInput: string;
}

export function parseHealthCheckCommand(input: string): ParsedCommand {
  const normalized = input.toLowerCase().trim();

  // Exit commands
  if (['exit', 'quit', 'q'].includes(normalized)) {
    return { action: 'exit', rawInput: input };
  }

  // Help commands
  if (['help', '?', 'h'].includes(normalized)) {
    return { action: 'help', rawInput: input };
  }

  // Default to 'check' action if any health-check related keywords
  const checkKeywords = ['check', 'run', 'test', 'scan', 'analyze', 'health'];
  const isCheckCommand = checkKeywords.some(kw => normalized.includes(kw));

  if (!isCheckCommand && normalized.length > 0) {
    return { action: 'unknown', rawInput: input };
  }

  // Extract mode (smoke/quick vs all/comprehensive/full)
  let mode: 'smoke' | 'all' = 'smoke';

  if (normalized.match(/\b(all|comprehensive|full|complete|thorough|deep)\b/)) {
    mode = 'all';
  } else if (normalized.match(/\b(smoke|quick|fast|rapid|brief)\b/)) {
    mode = 'smoke';
  }

  // Extract model (opus, sonnet, haiku, gpt, gemini)
  let model: string = 'sonnet';

  const modelNames = Object.keys(MODEL_MAP);
  for (const modelName of modelNames) {
    if (normalized.includes(modelName)) {
      model = modelName;
      break;
    }
  }

  return {
    action: 'check',
    mode,
    model,
    rawInput: input
  };
}

function displayChatHelp(): void {
  console.log(`${colors.cyan}${colors.bright}Available Commands:${colors.reset}`);
  console.log(`${colors.dim}  • "run quick check"          - Smoke test with default model${colors.reset}`);
  console.log(`${colors.dim}  • "run check with opus"      - Smoke test with Opus${colors.reset}`);
  console.log(`${colors.dim}  • "comprehensive check"      - Full check all categories${colors.reset}`);
  console.log(`${colors.dim}  • "all check with haiku"     - Full check with Haiku${colors.reset}`);
  console.log(`${colors.dim}  • "help"                     - Show this help${colors.reset}`);
  console.log(`${colors.dim}  • "exit"                     - Quit${colors.reset}\n`);
  console.log(`${colors.gray}Available models: ${Object.keys(MODEL_MAP).join(', ')}${colors.reset}`);
}

async function promptForInitialSetup(
  options: CLIOptions,
): Promise<{
  context: string;
  namespace: string;
  kubeconfig: string;
}> {
  // Check if we're in a TTY environment
  if (!process.stdin.isTTY) {
    throw new Error("Interactive mode requires a terminal.");
  }

  console.log(`${colors.cyan}${colors.bright}Welcome to Heimdall - Interactive Health Check${colors.reset}\n`);

  // Determine kubeconfig path
  const kubeconfigPath = options.kubeconfig ||
    process.env.KUBECONFIG ||
    resolve(homedir(), ".kube/config");

  console.log(`${colors.dim}📁 Kubeconfig: ${kubeconfigPath}${colors.reset}`);

  // Prompt for context
  let context: string;
  const kubeconfigData = await parseKubeconfig(kubeconfigPath);

  if (kubeconfigData && kubeconfigData.contexts.length > 0) {
    const contextNames = kubeconfigData.contexts.map((ctx) => ctx.name);
    const currentContext = kubeconfigData["current-context"];
    context = await promptForContext(contextNames, currentContext);
  } else {
    console.log(
      `${colors.yellow}⚠️  Could not parse kubeconfig at ${kubeconfigPath}${colors.reset}`,
    );
    console.log(`${colors.dim}   Falling back to manual context entry.${colors.reset}\n`);
    context = await promptForManualContext();
  }

  // Prompt for namespace
  const namespace = await promptForNamespace(context, kubeconfigPath);

  return { context, namespace, kubeconfig: kubeconfigPath };
}

export async function runInteractiveChatMode(
  options: CLIOptions,
): Promise<void> {
  // Step 1: Collect initial parameters (cluster, context, namespace)
  const setupParams = await promptForInitialSetup(options);

  // Step 2: Display welcome and help
  console.log(`\n${colors.green}✓ Setup complete!${colors.reset}`);
  console.log(`${colors.dim}Context: ${setupParams.context}${colors.reset}`);
  console.log(`${colors.dim}Namespace: ${setupParams.namespace}${colors.reset}\n`);

  displayChatHelp();

  // Import dependencies we'll need for health checks
  const { loadConfig, validateConfig } = await import("./config.js");
  const { runHealthCheck } = await import("./agent.js");
  const { getModelId } = await import("./constants.js");

  // Step 3: Chat loop - create fresh readline each iteration
  let shouldContinue = true;

  while (shouldContinue) {
    const rl = createInterface({ input, output });

    try {
      const userInput = (
        await rl.question(`\n${colors.cyan}heimdall>${colors.reset} `)
      ).trim();

      if (!userInput) {
        rl.close();
        continue;
      }

      const parsed = parseHealthCheckCommand(userInput);

      switch (parsed.action) {
        case 'exit':
          console.log(`\n${colors.dim}Goodbye!${colors.reset}\n`);
          rl.close();
          shouldContinue = false;
          break;

        case 'help':
          rl.close();
          console.log();
          displayChatHelp();
          break;

        case 'unknown':
          rl.close();
          console.log(`${colors.yellow}⚠️  Unknown command. Type 'help' for available commands.${colors.reset}`);
          break;

        case 'check':
          rl.close(); // Close before health check

          try {
            // Load config
            const config = loadConfig({
              kubeconfig: setupParams.kubeconfig,
              context: setupParams.context,
              namespace: setupParams.namespace,
            });

            validateConfig(config);

            const modelId = getModelId(parsed.model!);

            console.log(`\n${colors.dim}Running ${parsed.mode} check with ${parsed.model}...${colors.reset}\n`);

            // Run health check
            await runHealthCheck({
              config,
              verbose: options.verbose || false,
              model: modelId,
              mode: parsed.mode,
              transcriptPath: options.interactiveTranscript,
            });

            // After runHealthCheck returns, display help
            console.log(`\n${colors.green}✓ Health check complete!${colors.reset}\n`);
            displayChatHelp();
          } catch (error) {
            if (error instanceof Error) {
              console.error(`${colors.bright}❌ Health check failed: ${error.message}${colors.reset}`);
            } else {
              console.error(`${colors.bright}❌ An unknown error occurred${colors.reset}`);
            }
            console.log();
            displayChatHelp();
          }
          break;
      }
    } catch (error) {
      rl.close();
      throw error;
    }
  }
}

