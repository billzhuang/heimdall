import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HeimdallConfig } from "./config.js";
import { getSRESystemPrompt } from "./prompts.js";

export interface RunHealthCheckOptions {
  config: HeimdallConfig;
  verbose?: boolean;
}

// Colors for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};

export async function runHealthCheck(
  options: RunHealthCheckOptions
): Promise<void> {
  const { config, verbose } = options;

  const systemPrompt = getSRESystemPrompt(config);

  const userPrompt = `Perform a comprehensive health check on the EKS cluster "${config.cluster}".

Check the following in order:
1. Cluster connectivity
2. Node health (all nodes)
3. Pod health (${config.namespace === "all" ? "all namespaces" : `namespace: ${config.namespace}`})
4. Deployment health
5. Service health
6. Recent warning events
7. Helm releases
8. ConfigMaps & Secrets
9. Storage (PVC/PV)
10. Jobs & CronJobs

For each issue found, provide:
- Severity (CRITICAL or WARNING)
- Description of the problem
- Root cause analysis
- Suggested fix (kubectl command or YAML manifest)
- Risk level

At the end, provide a summary of findings.`;

  console.log(`\n${colors.cyan}${colors.bright}🔍 Starting health check for cluster: ${config.cluster}${colors.reset}\n`);
  console.log(`${colors.dim}Namespace: ${config.namespace}${colors.reset}`);
  console.log(`${colors.dim}Context: ${config.context || "default"}${colors.reset}\n`);
  console.log("─".repeat(60));

  try {
    for await (const message of query({
      prompt: userPrompt,
      options: {
        allowedTools: ["Bash"],
        systemPrompt,
        permissionMode: "bypassPermissions",
      },
    })) {
      // Handle different message types
      if ("type" in message) {
        const msg = message as Record<string, unknown>;

        // System init message
        if (msg.type === "system" && msg.subtype === "init") {
          console.log(`${colors.green}✓ Agent initialized${colors.reset}`);
          console.log(`${colors.dim}  Model: ${msg.model}${colors.reset}`);
          console.log(`${colors.dim}  Tools: ${(msg.tools as string[])?.join(", ")}${colors.reset}\n`);
        }

        // Assistant messages (thinking/text)
        if (msg.type === "assistant") {
          const content = msg.message as { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> };
          if (content?.content) {
            for (const block of content.content) {
              // Text output from assistant
              if (block.type === "text" && block.text) {
                console.log(block.text);
              }
              // Tool use - show what command is being run
              if (block.type === "tool_use") {
                const input = block.input as { command?: string; description?: string };
                console.log(`\n${colors.yellow}${colors.bright}🔧 Running: ${block.name}${colors.reset}`);
                if (input?.description) {
                  console.log(`${colors.dim}   ${input.description}${colors.reset}`);
                }
                if (input?.command && verbose) {
                  console.log(`${colors.gray}   $ ${input.command}${colors.reset}`);
                } else if (input?.command) {
                  // Show truncated command
                  const cmd = input.command.length > 80
                    ? input.command.substring(0, 80) + "..."
                    : input.command;
                  console.log(`${colors.gray}   $ ${cmd}${colors.reset}`);
                }
              }
            }
          }
        }

        // User messages (tool results)
        if (msg.type === "user" && verbose) {
          const content = msg.message as { content?: Array<{ type: string; content?: string }> };
          if (content?.content) {
            for (const block of content.content) {
              if (block.type === "tool_result" && block.content) {
                // Show first few lines of output in verbose mode
                const lines = block.content.split("\n").slice(0, 10);
                console.log(`${colors.dim}${lines.join("\n")}${colors.reset}`);
                if (block.content.split("\n").length > 10) {
                  console.log(`${colors.dim}   ... (${block.content.split("\n").length - 10} more lines)${colors.reset}`);
                }
              }
            }
          }
        }

        // Final result
        if (msg.type === "result") {
          console.log("\n" + "─".repeat(60));
          if (msg.subtype === "success") {
            console.log(`${colors.green}${colors.bright}✅ Health check complete${colors.reset}\n`);
            if (msg.result) {
              console.log(msg.result as string);
            }
          } else {
            console.log(`${colors.yellow}⚠️  Health check finished with status: ${msg.subtype}${colors.reset}\n`);
          }

          // Show usage stats
          if (msg.total_cost_usd !== undefined) {
            console.log(`\n${colors.dim}Cost: $${(msg.total_cost_usd as number).toFixed(4)}${colors.reset}`);
          }
          if (msg.duration_ms !== undefined) {
            console.log(`${colors.dim}Duration: ${((msg.duration_ms as number) / 1000).toFixed(1)}s${colors.reset}`);
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`\n${colors.bright}❌ Error running health check: ${error.message}${colors.reset}`);
      if (verbose) {
        console.error(error.stack);
      }
    } else {
      console.error("\n❌ An unknown error occurred");
    }
    process.exit(1);
  }
}
