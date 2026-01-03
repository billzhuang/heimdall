#!/usr/bin/env node

import "dotenv/config";
import { Command } from "commander";
import { loadConfig, validateConfig } from "./config.js";
import { runHealthCheck } from "./agent.js";
import { getModelId } from "./constants.js";

// Colors for terminal output
const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  bright: "\x1b[1m",
};

const program = new Command();

program
  .name("heimdall")
  .description("AI-powered SRE agent for EKS health checks")
  .version("0.1.0");

program
  .command("check")
  .description(`Run health checks on an EKS cluster

Modes:
  Traditional: Provide flags (--cluster, --context) to run check and exit
  Interactive: Run without parameters for interactive chat mode`)
  .option("-c, --cluster <name>", "EKS cluster name (required in traditional mode)")
  .option(
    "-k, --kubeconfig <path>",
    "Path to kubeconfig file",
    process.env.KUBECONFIG,
  )
  .option("--context <name>", "Kubernetes context to use")
  .option("-n, --namespace <name>", "Namespace to check (default: all)")
  .option("-v, --verbose", "Show verbose output including tool calls", false)
  .option(
    "--interactive-transcript <path>",
    "Write interactive transcript to path (JSONL)",
  )
  .option(
    "-m, --model <name>",
    "Claude model to use (sonnet, opus, haiku)",
  )
  .option(
    "--mode <type>",
    "Health check mode: smoke (quick) or all (comprehensive)",
  )
  .action(async (options) => {
    try {
      // Detect mode based on whether any parameters are provided
      // Only count actual parameter flags, not output/behavior flags
      // Note: kubeconfig is excluded because it has a default value from env
      const hasAnyParam = !!(
        options.cluster ||
        options.context ||
        options.namespace ||
        options.model ||
        options.mode
      );

      let finalOptions = options;
      let interactiveMode = false;

      if (hasAnyParam) {
        // Mode 1: Traditional - All required params must be provided
        if (!options.cluster) {
          throw new Error(
            "When using flags, --cluster is required.\n" +
            "For interactive mode, run without any parameters."
          );
        }
        if (!options.context) {
          throw new Error(
            "When using flags, --context is required.\n" +
            "For interactive mode, run without any parameters."
          );
        }
        // Traditional mode - no chat
        interactiveMode = false;
      } else {
        // Mode 2: Interactive - Enter chat mode
        const { runInteractiveChatMode } = await import("./interactive.js");
        await runInteractiveChatMode(options);
        return; // Exit after chat mode ends
      }

      // Apply defaults for options not provided (after interactive prompting)
      finalOptions.namespace = finalOptions.namespace || "all";
      finalOptions.model = finalOptions.model || "sonnet";
      finalOptions.mode = finalOptions.mode || "smoke";

      const config = loadConfig({
        cluster: finalOptions.cluster,
        kubeconfig: finalOptions.kubeconfig,
        context: finalOptions.context,
        namespace: finalOptions.namespace,
      });

      validateConfig(config);

      // Map model shorthand to full model ID
      const model = getModelId(finalOptions.model);

      await runHealthCheck({
        config,
        verbose: finalOptions.verbose,
        model,
        mode: finalOptions.mode,
        interactive: interactiveMode,
        interactiveTranscriptPath: finalOptions.interactiveTranscript,
      });
    } catch (error) {
      if (error instanceof Error) {
        console.error(`\n❌ Error: ${error.message}\n`);
      } else {
        console.error("\n❌ An unknown error occurred\n");
      }
      process.exit(1);
    }
  });

program.parse();
