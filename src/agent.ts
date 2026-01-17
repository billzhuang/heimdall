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
  transcriptPath?: string;
}

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  gray: "\x1b[90m",
};

type TranscriptEntry = {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
};

function recordTranscriptEntry(
  transcript: TranscriptEntry[],
  role: TranscriptEntry["role"],
  content: string,
): void {
  transcript.push({ role, content, timestamp: new Date().toISOString() });
}

async function persistTranscript(
  transcript: TranscriptEntry[],
  transcriptPath?: string,
): Promise<void> {
  if (!transcriptPath) return;
  const body = transcript.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(transcriptPath, body, "utf8");
}

type StreamUserMessage = {
  type: "user";
  session_id: string;
  message: { role: "user"; content: Array<{ type: "text"; text: string }> };
  parent_tool_use_id: null;
};

class UserMessageQueue implements AsyncIterable<StreamUserMessage> {
  private closed = false;
  private queue: StreamUserMessage[] = [];
  private resolvers: Array<(value: IteratorResult<StreamUserMessage>) => void> = [];

  enqueue(message: StreamUserMessage): void {
    if (this.closed) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: message, done: false });
    } else {
      this.queue.push(message);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      resolver?.({ value: undefined as unknown as StreamUserMessage, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamUserMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as StreamUserMessage, done: true });
        }
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

function createUserMessage(text: string): StreamUserMessage {
  return {
    type: "user",
    session_id: "",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  };
}

async function promptForFollowUp(
  rl: ReturnType<typeof createInterface>,
): Promise<string | null> {
  try {
    const answer = (await rl.question("Follow-up (empty or 'exit' to quit): ")).trim();
    return !answer || answer.toLowerCase() === "exit" ? null : answer;
  } catch {
    return null;
  }
}

function buildUserPrompt(config: HeimdallConfig, mode?: string): string {
  const modeType = mode || "smoke";
  const namespaceInfo = config.namespace === "all" ? "all namespaces" : `namespace: ${config.namespace}`;

  const basePrompt = modeType === "smoke"
    ? `Perform a quick smoke health check on the EKS cluster "${config.cluster}" (${namespaceInfo}).

Run these essential checks:
1. Node Health - Check all nodes for NotReady, MemoryPressure, DiskPressure conditions
2. Critical Pod Failures - Check for CrashLoopBackOff, ImagePullBackOff, Pending pods
3. Recent Warning Events - Last 20 warning events to spot immediate issues`
    : `Perform a comprehensive health check on the EKS cluster "${config.cluster}" (${namespaceInfo}).

Check the following in order:
1. Cluster connectivity
2. Node health (all nodes)
3. Pod health (${namespaceInfo})
4. Deployment health
5. Service health
6. Ingress health (Traefik/ALB routing)
7. Recent warning events
8. Helm releases
9. ConfigMaps & Secrets
10. Storage (PVC/PV)
11. Jobs & CronJobs`;

  return `${basePrompt}

After the summary, be ready to answer follow-up questions about this run. Do not re-run the full checklist unless asked.`;
}

export async function runHealthCheck(options: RunHealthCheckOptions): Promise<void> {
  const { config, verbose, model, mode, transcriptPath } = options;

  const systemPrompt = getSRESystemPrompt(config, mode);
  const selectedModel = model || "claude-sonnet-4-5-20250929";
  const userPrompt = buildUserPrompt(config, mode);

  console.log(`\n${colors.cyan}${colors.bright}🔍 Starting health check for cluster: ${config.cluster}${colors.reset}\n`);
  console.log(`${colors.dim}Namespace: ${config.namespace}${colors.reset}`);
  console.log(`${colors.dim}Context: ${config.context || "default"}${colors.reset}`);
  console.log(`${colors.dim}Mode: ${mode || "smoke"}${colors.reset}`);
  console.log(`${colors.dim}Model: ${selectedModel}${colors.reset}\n`);
  console.log("─".repeat(60));

  const transcript: TranscriptEntry[] = [];
  recordTranscriptEntry(transcript, "system", systemPrompt);
  recordTranscriptEntry(transcript, "user", userPrompt);
  await persistTranscript(transcript, transcriptPath);

  const queryOptions = {
    allowedTools: ["Bash"],
    systemPrompt,
    permissionMode: "bypassPermissions" as const,
    model: selectedModel,
    persistSession: false,
  };

  const messageQueue = new UserMessageQueue();
  const rl = createInterface({ input, output });
  messageQueue.enqueue(createUserMessage(userPrompt));

  let assistantBuffer = "";
  let shouldExit = false;

  try {
    const queryStream = query({ prompt: messageQueue, options: queryOptions });

    for await (const message of queryStream) {
      if (shouldExit) break;

      if ("type" in message) {
        const msg = message as Record<string, unknown>;

        if (msg.type === "system" && msg.subtype === "init") {
          console.log(`${colors.green}✓ Agent initialized${colors.reset}`);
          console.log(`${colors.dim}  Model: ${msg.model}${colors.reset}`);
          console.log(`${colors.dim}  Tools: ${(msg.tools as string[])?.join(", ")}${colors.reset}\n`);
        }

        if (msg.type === "assistant") {
          const content = msg.message as { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> };
          for (const block of content?.content || []) {
            if (block.type === "text" && block.text) {
              console.log(block.text);
              assistantBuffer += block.text + "\n";
            }
            if (block.type === "tool_use") {
              const inp = block.input as { command?: string; description?: string };
              console.log(`\n${colors.yellow}${colors.bright}🔧 Running: ${block.name}${colors.reset}`);
              if (inp?.description) console.log(`${colors.dim}   ${inp.description}${colors.reset}`);
              if (inp?.command) {
                const cmd = verbose ? inp.command : (inp.command.length > 80 ? inp.command.substring(0, 80) + "..." : inp.command);
                console.log(`${colors.gray}   $ ${cmd}${colors.reset}`);
              }
            }
          }
        }

        if (msg.type === "user" && verbose) {
          const content = msg.message as { content?: Array<{ type: string; content?: string }> };
          for (const block of content?.content || []) {
            if (block.type === "tool_result" && block.content) {
              const lines = block.content.split("\n").slice(0, 10);
              console.log(`${colors.dim}${lines.join("\n")}${colors.reset}`);
              if (block.content.split("\n").length > 10) {
                console.log(`${colors.dim}   ... (${block.content.split("\n").length - 10} more lines)${colors.reset}`);
              }
            }
          }
        }

        if (msg.type === "result") {
          console.log("\n" + "─".repeat(60));
          console.log(msg.subtype === "success"
            ? `${colors.green}${colors.bright}✅ Health check complete${colors.reset}\n`
            : `${colors.yellow}⚠️  Health check finished with status: ${msg.subtype}${colors.reset}\n`);

          if (msg.total_cost_usd !== undefined) {
            console.log(`\n${colors.dim}Cost: ${(msg.total_cost_usd as number).toFixed(4)}${colors.reset}`);
          }
          if (msg.duration_ms !== undefined) {
            console.log(`${colors.dim}Duration: ${((msg.duration_ms as number) / 1000).toFixed(1)}s${colors.reset}`);
          }

          if (assistantBuffer.trim()) {
            recordTranscriptEntry(transcript, "assistant", assistantBuffer.trim());
            assistantBuffer = "";
          }
          await persistTranscript(transcript, transcriptPath);

          console.log(`\n${colors.cyan}${colors.bright}💬 Interactive Mode - Follow-up Questions${colors.reset}`);
          console.log(`${colors.dim}You can now ask follow-up questions about this health check.${colors.reset}`);
          console.log(`${colors.dim}Press Enter or type 'exit' to return to main menu.${colors.reset}\n`);

          const followUp = await promptForFollowUp(rl);
          if (!followUp) {
            rl.close();
            messageQueue.close();
            shouldExit = true;
            await queryStream.interrupt();
          } else {
            recordTranscriptEntry(transcript, "user", followUp);
            await persistTranscript(transcript, transcriptPath);
            messageQueue.enqueue(createUserMessage(followUp));
          }
        }
      }
    }
  } catch (error) {
    rl.close();
    if (error instanceof Error) {
      console.error(`\n${colors.bright}❌ Error running health check: ${error.message}${colors.reset}`);
      if (verbose) console.error(error.stack);
    } else {
      console.error("\n❌ An unknown error occurred");
    }
    throw error;
  }
}
