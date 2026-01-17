#!/usr/bin/env node

import "dotenv/config";
import { Command } from "commander";
import { runInkTUI } from "./tui/index.js";

const program = new Command();

program
  .name("heimdall")
  .description("AI-powered Kubernetes assistant and SRE agent")
  .version("0.1.0");

// Default command - run the interactive TUI
program
  .option(
    "-k, --kubeconfig <path>",
    "Path to kubeconfig file",
    process.env.KUBECONFIG,
  )
  .option("-v, --verbose", "Show verbose output including tool calls", false)
  .action(async (options) => {
    try {
      await runInkTUI({
        kubeconfig: options.kubeconfig,
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
