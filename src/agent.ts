import { query } from "@anthropic-ai/claude-agent-sdk";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { HeimdallConfig } from "./config.js";
import { getSRESystemPrompt } from "./prompts.js";

export interface RunHealthCheckOptions {
  config: HeimdallConfig;
  verbose?: boolean;
  model?: string;
  mode?: string;
  interactive?: boolean;
  interactiveTranscriptPath?: string;
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

type TranscriptEntry = {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
};

function formatTranscriptEntry(entry: TranscriptEntry): string {
  return JSON.stringify(entry);
}

function recordTranscriptEntry(
  transcript: TranscriptEntry[],
  role: TranscriptEntry["role"],
  content: string,
): void {
  transcript.push({
    role,
    content,
    timestamp: new Date().toISOString(),
  });
}

async function persistTranscript(
  transcript: TranscriptEntry[],
  transcriptPath?: string,
): Promise<void> {
  if (!transcriptPath) {
    return;
  }

  const body = transcript.map(formatTranscriptEntry).join("\n") + "\n";
  await writeFile(transcriptPath, body, "utf8");
}

type StreamUserMessage = {
  type: "user";
  session_id: string;
  message: {
    role: "user";
    content: Array<{ type: "text"; text: string }>;
  };
  parent_tool_use_id: null;
};

class UserMessageQueue implements AsyncIterable<StreamUserMessage> {
  private closed = false;
  private queue: StreamUserMessage[] = [];
  private resolvers: Array<
    (value: IteratorResult<StreamUserMessage>) => void
  > = [];

  enqueue(message: StreamUserMessage): void {
    if (this.closed) {
      return;
    }

    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: message, done: false });
      return;
    }

    this.queue.push(message);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      if (resolver) {
        resolver({
          value: undefined as unknown as StreamUserMessage,
          done: true,
        });
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamUserMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          const message = this.queue.shift();
          return Promise.resolve({ value: message!, done: false });
        }

        if (this.closed) {
          return Promise.resolve({
            value: undefined as unknown as StreamUserMessage,
            done: true,
          });
        }

        return new Promise<IteratorResult<StreamUserMessage>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

function createUserMessage(text: string): StreamUserMessage {
  return {
    type: "user",
    session_id: "",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
  };
}

type ReadlineInterface = ReturnType<typeof createInterface>;

async function promptForFollowUp(
  rl: ReadlineInterface,
): Promise<string | null> {
  try {
    const answer = (await rl.question(
      "Follow-up (empty or 'exit' to quit): ",
    )).trim();
    if (!answer || answer.toLowerCase() === "exit") {
      return null;
    }

    return answer;
  } catch {
    return null;
  }
}

function buildUserPrompt(
  config: HeimdallConfig,
  mode?: string,
  interactive?: boolean,
): string {
  const modeType = mode || "smoke";
  const namespaceInfo = config.namespace === "all"
    ? "all namespaces"
    : `namespace: ${config.namespace}`;

  let basePrompt: string;

  if (modeType === "smoke") {
    basePrompt = `Perform a QUICK smoke health check on the EKS cluster "${config.cluster}" (${namespaceInfo}).

Run these essential checks only:

1. **Node Health** - Check all nodes for NotReady, MemoryPressure, DiskPressure conditions
2. **Critical Pod Failures** - Check for CrashLoopBackOff, ImagePullBackOff, Pending pods (${namespaceInfo})
3. **Recent Warning Events** - Last 20 warning events to spot immediate issues

**IMPORTANT - Keep output LEAN and PRECISE:**
- Only report actual issues found - skip "no issues" sections
- Use concise bullet points, not verbose paragraphs
- Include specific resource names and error messages
- Skip generic explanations - focus on actionable information
- If everything is healthy, just say "✅ No issues detected" with a brief summary

For each issue found, provide:
- Severity (CRITICAL or WARNING)
- Resource name and location
- Problem description (1-2 sentences max)
- Suggested fix (command or brief YAML)

At the end, provide a brief summary (3-5 lines max).`;
  } else {
    // Existing comprehensive prompt
    basePrompt = `Perform a comprehensive health check on the EKS cluster "${config.cluster}" (${namespaceInfo}).

Check the following in order:
1. Cluster connectivity
2. Node health (all nodes)
3. Pod health (${namespaceInfo})
4. Deployment health
5. Service health
6. Recent warning events
7. Helm releases
8. ConfigMaps & Secrets
9. Storage (PVC/PV)
10. Jobs & CronJobs

**IMPORTANT - Keep output LEAN and PRECISE:**
- Only report actual issues found - skip "no issues" sections
- Use concise bullet points, not verbose paragraphs
- Include specific resource names and error messages
- Skip generic explanations - focus on actionable information
- For healthy components, just say "✅ [Component] healthy" without details

For each issue found, provide:
- Severity (CRITICAL or WARNING)
- Resource name and location
- Problem description (1-2 sentences max)
- Suggested fix (command or brief YAML)

At the end, provide a brief summary (3-5 lines max).`;
  }

  if (!interactive) {
    return basePrompt;
  }

  return `${basePrompt}

After the summary, be ready to answer follow-up questions about this run. Do not re-run the full checklist unless asked.`;
}

export async function runHealthCheck(
  options: RunHealthCheckOptions,
): Promise<void> {
  const { config, verbose, model, mode, interactive, interactiveTranscriptPath } =
    options;

  const systemPrompt = getSRESystemPrompt(config, mode);

  // Default to Sonnet for cost efficiency (Opus is ~10x more expensive)
  const selectedModel = model || "claude-sonnet-4-5-20250929";

  const userPrompt = buildUserPrompt(config, mode, interactive);

  console.log(
    `\n${colors.cyan}${colors.bright}🔍 Starting health check for cluster: ${config.cluster}${colors.reset}\n`,
  );
  console.log(`${colors.dim}Namespace: ${config.namespace}${colors.reset}`);
  console.log(
    `${colors.dim}Context: ${config.context || "default"}${colors.reset}`,
  );
  console.log(`${colors.dim}Mode: ${mode || "smoke"}${colors.reset}`);
  console.log(`${colors.dim}Model: ${selectedModel}${colors.reset}\n`);
  console.log("─".repeat(60));

  const transcript: TranscriptEntry[] = [];
  const shouldRecordTranscript = Boolean(
    interactive || interactiveTranscriptPath,
  );

  if (shouldRecordTranscript) {
    recordTranscriptEntry(transcript, "system", systemPrompt);
    recordTranscriptEntry(transcript, "user", userPrompt);
    await persistTranscript(transcript, interactiveTranscriptPath);
  }

  const queryOptions = {
    allowedTools: ["Bash"],
    systemPrompt,
    permissionMode: "bypassPermissions" as const,
    model: selectedModel,
    ...(interactive || interactiveTranscriptPath
      ? { persistSession: false }
      : {}),
  };

  const messageQueue = interactive ? new UserMessageQueue() : null;
  const rl = interactive ? createInterface({ input, output }) : null;

  if (interactive && messageQueue) {
    messageQueue.enqueue(createUserMessage(userPrompt));
  }

  let assistantBuffer = "";
  let shouldExit = false;

  try {
    const queryStream = query({
      prompt: interactive && messageQueue ? messageQueue : userPrompt,
      options: queryOptions,
    });

    for await (const message of queryStream) {
      // Handle different message types
      if (shouldExit) {
        break;
      }

      if ("type" in message) {
        const msg = message as Record<string, unknown>;

        // System init message
        if (msg.type === "system" && msg.subtype === "init") {
          console.log(`${colors.green}✓ Agent initialized${colors.reset}`);
          console.log(`${colors.dim}  Model: ${msg.model}${colors.reset}`);
          console.log(
            `${colors.dim}  Tools: ${(msg.tools as string[])?.join(", ")}${colors.reset}\n`,
          );
        }

        // Assistant messages (thinking/text)
        if (msg.type === "assistant") {
          const content = msg.message as {
            content?: Array<{
              type: string;
              text?: string;
              name?: string;
              input?: unknown;
            }>;
          };
          if (content?.content) {
            for (const block of content.content) {
              // Text output from assistant
              if (block.type === "text" && block.text) {
                console.log(block.text);
                assistantBuffer += block.text + "\n";
              }
              // Tool use - show what command is being run
              if (block.type === "tool_use") {
                const input = block.input as {
                  command?: string;
                  description?: string;
                };
                console.log(
                  `\n${colors.yellow}${colors.bright}🔧 Running: ${block.name}${colors.reset}`,
                );
                if (input?.description) {
                  console.log(
                    `${colors.dim}   ${input.description}${colors.reset}`,
                  );
                }
                if (input?.command && verbose) {
                  console.log(
                    `${colors.gray}   $ ${input.command}${colors.reset}`,
                  );
                } else if (input?.command) {
                  // Show truncated command
                  const cmd =
                    input.command.length > 80
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
          const content = msg.message as {
            content?: Array<{ type: string; content?: string }>;
          };
          if (content?.content) {
            for (const block of content.content) {
              if (block.type === "tool_result" && block.content) {
                // Show first few lines of output in verbose mode
                const lines = block.content.split("\n").slice(0, 10);
                console.log(`${colors.dim}${lines.join("\n")}${colors.reset}`);
                if (block.content.split("\n").length > 10) {
                  console.log(
                    `${colors.dim}   ... (${block.content.split("\n").length - 10} more lines)${colors.reset}`,
                  );
                }
              }
            }
          }
        }

        // Final result
        if (msg.type === "result") {
          console.log("\n" + "─".repeat(60));
          if (msg.subtype === "success") {
            console.log(
              `${colors.green}${colors.bright}✅ Health check complete${colors.reset}\n`,
            );
            // Note: Don't print msg.result here - it was already streamed in real-time
          } else {
            console.log(
              `${colors.yellow}⚠️  Health check finished with status: ${msg.subtype}${colors.reset}\n`,
            );
          }

          // Show usage stats
          if (msg.total_cost_usd !== undefined) {
            console.log(
              `\n${colors.dim}Cost: $${(msg.total_cost_usd as number).toFixed(4)}${colors.reset}`,
            );
          }
          if (msg.duration_ms !== undefined) {
            console.log(
              `${colors.dim}Duration: ${((msg.duration_ms as number) / 1000).toFixed(1)}s${colors.reset}`,
            );
          }

          if (assistantBuffer.trim().length > 0 && shouldRecordTranscript) {
            recordTranscriptEntry(
              transcript,
              "assistant",
              assistantBuffer.trim(),
            );
            assistantBuffer = "";
          }

          if (shouldRecordTranscript) {
            await persistTranscript(transcript, interactiveTranscriptPath);
          }

          if (interactive && messageQueue && rl) {
            const followUp = await promptForFollowUp(rl);
            if (!followUp) {
              rl.close();
              messageQueue.close();
              shouldExit = true;
              await queryStream.interrupt();
            } else {
              recordTranscriptEntry(transcript, "user", followUp);
              await persistTranscript(transcript, interactiveTranscriptPath);
              messageQueue.enqueue(createUserMessage(followUp));
            }
          }
        }

      }
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(
        `\n${colors.bright}❌ Error running health check: ${error.message}${colors.reset}`,
      );
      if (verbose) {
        console.error(error.stack);
      }
    } else {
      console.error("\n❌ An unknown error occurred");
    }
    if (rl) {
      rl.close();
    }
    process.exit(1);
  }
}
