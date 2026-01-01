#!/usr/bin/env node

import "dotenv/config";
import { Command } from "commander";
import { loadConfig, validateConfig } from "./config.js";
import { runHealthCheck } from "./agent.js";

const program = new Command();

program
  .name("heimdall")
  .description("AI-powered SRE agent for EKS health checks")
  .version("0.1.0");

program
  .command("check")
  .description("Run health checks on an EKS cluster")
  .requiredOption("-c, --cluster <name>", "EKS cluster name")
  .option(
    "-k, --kubeconfig <path>",
    "Path to kubeconfig file",
    process.env.KUBECONFIG
  )
  .option("--context <name>", "Kubernetes context to use")
  .option(
    "-n, --namespace <name>",
    "Namespace to check (default: all)",
    "all"
  )
  .option("-v, --verbose", "Show verbose output including tool calls", false)
  .action(async (options) => {
    try {
      const config = loadConfig({
        cluster: options.cluster,
        kubeconfig: options.kubeconfig,
        context: options.context,
        namespace: options.namespace,
      });

      validateConfig(config);

      await runHealthCheck({
        config,
        verbose: options.verbose,
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
