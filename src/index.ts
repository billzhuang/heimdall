#!/usr/bin/env node

import "dotenv/config";
import { Command } from "commander";
import { runInkTUI } from "./tui/index.js";

const program = new Command();

program
  .name("heimdall")
  .description("AI-powered SRE agent for EKS health checks")
  .version("0.1.0");

program
  .command("check", { isDefault: true })
  .description("Run interactive health check on an EKS cluster")
  .option(
    "-k, --kubeconfig <path>",
    "Path to kubeconfig file",
    process.env.KUBECONFIG,
  )
  .option("-v, --verbose", "Show verbose output including tool calls", false)
  .option(
    "--transcript <path>",
    "Write session transcript to path (JSONL)",
  )
  .action(async (options) => {
    try {
      await runInkTUI({
        kubeconfig: options.kubeconfig,
        verbose: options.verbose,
        transcriptPath: options.transcript,
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
