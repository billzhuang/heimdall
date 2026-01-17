import { query } from '@anthropic-ai/claude-agent-sdk';
import type { HeimdallConfig } from '../config.js';
import { getSRESystemPrompt } from '../prompts.js';

export interface OutputMessage {
  id: string;
  type: 'system' | 'user' | 'assistant' | 'tool' | 'error' | 'info';
  content: string;
  timestamp: Date;
  metadata?: {
    toolName?: string;
    command?: string;
    cost?: number;
    duration?: number;
  };
}

export interface ConversationTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface AgentRunnerOptions {
  config: HeimdallConfig;
  model: string;
  verbose?: boolean;
  transcriptPath?: string;
}

export interface AgentRunnerCallbacks {
  onMessage: (message: OutputMessage) => void;
  onToolUse: (toolName: string, command?: string) => void;
  onComplete: (cost?: number, duration?: number) => void;
  onError: (error: Error) => void;
}

// Conversation context manager
export class ConversationContext {
  private turns: ConversationTurn[] = [];
  private sessionId: string;

  constructor() {
    this.sessionId = this.generateId();
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  addTurn(role: 'user' | 'assistant', content: string): ConversationTurn {
    const turn: ConversationTurn = {
      id: this.generateId(),
      role,
      content,
      timestamp: new Date(),
    };
    this.turns.push(turn);
    return turn;
  }

  getTurns(): ConversationTurn[] {
    return [...this.turns];
  }

  getHistory(): string {
    return this.turns
      .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
      .join('\n\n');
  }

  clear(): void {
    this.turns = [];
    this.sessionId = this.generateId();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  isEmpty(): boolean {
    return this.turns.length === 0;
  }

  compact(): string {
    // Return a summary of the conversation for context reduction
    if (this.turns.length === 0) return '';
    
    const summary = `Previous conversation summary (${this.turns.length} turns):\n` +
      this.turns.slice(-4).map(t => 
        `${t.role}: ${t.content.slice(0, 200)}${t.content.length > 200 ? '...' : ''}`
      ).join('\n');
    
    return summary;
  }

  /**
   * Get memory/context statistics
   */
  getStats(): {
    turnCount: number;
    userTurns: number;
    assistantTurns: number;
    totalChars: number;
    estimatedTokens: number;
    sessionId: string;
    oldestTurn: Date | null;
    newestTurn: Date | null;
  } {
    const userTurns = this.turns.filter(t => t.role === 'user').length;
    const assistantTurns = this.turns.filter(t => t.role === 'assistant').length;
    const totalChars = this.turns.reduce((sum, t) => sum + t.content.length, 0);
    // Rough estimate: ~4 chars per token
    const estimatedTokens = Math.ceil(totalChars / 4);
    
    return {
      turnCount: this.turns.length,
      userTurns,
      assistantTurns,
      totalChars,
      estimatedTokens,
      sessionId: this.sessionId,
      oldestTurn: this.turns.length > 0 ? this.turns[0].timestamp : null,
      newestTurn: this.turns.length > 0 ? this.turns[this.turns.length - 1].timestamp : null,
    };
  }
}

// Stream user message type for the SDK
type StreamUserMessage = {
  type: 'user';
  session_id: string;
  message: { role: 'user'; content: Array<{ type: 'text'; text: string }> };
  parent_tool_use_id: null;
};

// Message queue for streaming
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
    type: 'user',
    session_id: '',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  };
}

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function buildUserPrompt(config: HeimdallConfig, mode: 'smoke' | 'all'): string {
  const namespaceInfo = config.namespace === 'all' ? 'all namespaces' : `namespace: ${config.namespace}`;

  const basePrompt = mode === 'smoke'
    ? `Perform a quick smoke health check on the cluster (context: ${config.context}, ${namespaceInfo}).

Run these essential checks:
1. Node Health - Check all nodes for NotReady, MemoryPressure, DiskPressure conditions
2. Critical Pod Failures - Check for CrashLoopBackOff, ImagePullBackOff, Pending pods
3. Recent Warning Events - Last 20 warning events to spot immediate issues`
    : `Perform a comprehensive health check on the cluster (context: ${config.context}, ${namespaceInfo}).

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

/**
 * Run a quick health check (smoke or comprehensive)
 */
export async function runQuickCheck(
  mode: 'smoke' | 'all',
  options: AgentRunnerOptions,
  callbacks: AgentRunnerCallbacks,
  context?: ConversationContext
): Promise<void> {
  const { config, model, verbose } = options;
  const systemPrompt = getSRESystemPrompt(config, mode);
  const userPrompt = buildUserPrompt(config, mode);

  // Add to conversation context if provided
  context?.addTurn('user', `[Quick Check - ${mode}]`);

  await runAgentStream(userPrompt, systemPrompt, model, verbose, callbacks, context);
}

/**
 * Run a general K8s query through the agent
 */
export async function runAgentQuery(
  queryText: string,
  options: AgentRunnerOptions,
  callbacks: AgentRunnerCallbacks,
  context?: ConversationContext
): Promise<void> {
  const { config, model, verbose } = options;
  
  // Build system prompt for general queries
  const systemPrompt = `You are Heimdall, an expert SRE agent for Kubernetes clusters.
You are connected to cluster context: ${config.context}
Namespace scope: ${config.namespace === 'all' ? 'all namespaces' : config.namespace}

You can run kubectl commands to investigate and answer questions about the cluster.
Use kubectl --context=${config.context} for all commands.
${config.namespace !== 'all' ? `Use -n ${config.namespace} for namespace-scoped resources.` : 'Use -A for namespace-scoped resources.'}

Be concise and actionable in your responses.
Only run read-only commands (get, describe, logs) - do not modify the cluster.`;

  // Include conversation history for follow-ups
  let fullQuery = queryText;
  if (context && !context.isEmpty()) {
    const history = context.getHistory();
    fullQuery = `Previous conversation:\n${history}\n\nNew question: ${queryText}`;
  }

  context?.addTurn('user', queryText);

  await runAgentStream(fullQuery, systemPrompt, model, verbose, callbacks, context);
}

/**
 * Internal function to run the agent stream
 */
async function runAgentStream(
  userPrompt: string,
  systemPrompt: string,
  model: string,
  verbose: boolean | undefined,
  callbacks: AgentRunnerCallbacks,
  context?: ConversationContext
): Promise<void> {
  const queryOptions = {
    allowedTools: ['Bash'],
    systemPrompt,
    permissionMode: 'bypassPermissions' as const,
    model,
    persistSession: false,
  };

  const messageQueue = new UserMessageQueue();
  messageQueue.enqueue(createUserMessage(userPrompt));

  let assistantBuffer = '';

  try {
    const queryStream = query({ prompt: messageQueue, options: queryOptions });

    for await (const message of queryStream) {
      if ('type' in message) {
        const msg = message as Record<string, unknown>;

        if (msg.type === 'system' && msg.subtype === 'init') {
          callbacks.onMessage({
            id: generateMessageId(),
            type: 'system',
            content: `Agent initialized with model: ${msg.model}`,
            timestamp: new Date(),
          });
        }

        if (msg.type === 'assistant') {
          const content = msg.message as { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> };
          for (const block of content?.content || []) {
            if (block.type === 'text' && block.text) {
              callbacks.onMessage({
                id: generateMessageId(),
                type: 'assistant',
                content: block.text,
                timestamp: new Date(),
              });
              assistantBuffer += block.text + '\n';
            }
            if (block.type === 'tool_use') {
              const inp = block.input as { command?: string; description?: string };
              callbacks.onToolUse(block.name || 'unknown', inp?.command);
              callbacks.onMessage({
                id: generateMessageId(),
                type: 'tool',
                content: inp?.description || `Running ${block.name}`,
                timestamp: new Date(),
                metadata: {
                  toolName: block.name,
                  command: inp?.command,
                },
              });
            }
          }
        }

        if (msg.type === 'user' && verbose) {
          const content = msg.message as { content?: Array<{ type: string; content?: string }> };
          for (const block of content?.content || []) {
            if (block.type === 'tool_result' && block.content) {
              callbacks.onMessage({
                id: generateMessageId(),
                type: 'info',
                content: block.content.split('\n').slice(0, 10).join('\n'),
                timestamp: new Date(),
              });
            }
          }
        }

        if (msg.type === 'result') {
          const cost = msg.total_cost_usd as number | undefined;
          const duration = msg.duration_ms as number | undefined;

          // Add assistant response to context
          if (assistantBuffer.trim() && context) {
            context.addTurn('assistant', assistantBuffer.trim());
          }

          callbacks.onComplete(cost, duration);
          messageQueue.close();
          break;
        }
      }
    }
  } catch (error) {
    messageQueue.close();
    callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}
