#!/usr/bin/env node

import "dotenv/config";
import { Command } from "commander";
import { loadConfig, validateConfig } from "./config.js";
import { runHealthCheck } from "./agent.js";
import { getModelId } from "./constants.js";

const program = new Command();

program
  .name("heimdall")
  .description("AI-powered SRE agent for EKS health checks")
  .version("0.1.0");

program
  .command("check")
  .description("Run health checks on an EKS cluster")
  .option("-c, --cluster <name>", "EKS cluster name (interactive if not provided)")
  .option(
    "-k, --kubeconfig <path>",
    "Path to kubeconfig file",
    process.env.KUBECONFIG,
  )
  .option("--context <name>", "Kubernetes context to use")
  .option("-n, --namespace <name>", "Namespace to check (default: all)")
  .option("-v, --verbose", "Show verbose output including tool calls", false)
  .option("--interactive", "Enable post-report interactive Q&A", false)
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
      // Check if interactive prompting is needed
      const shouldPrompt = !options.cluster;
      let finalOptions = options;

      if (shouldPrompt) {
        // Lazy import interactive module
        const { promptForMissingParams } = await import("./interactive.js");

        // Prompt for missing parameters BEFORE validation
        finalOptions = await promptForMissingParams(options);
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
        interactive: finalOptions.interactive,
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
