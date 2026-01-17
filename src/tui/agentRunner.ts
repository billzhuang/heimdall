import { query } from '@anthropic-ai/claude-agent-sdk';
import type { HeimdallConfig } from './types.js';

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
  onToolUse: (toolName: string, details?: string) => void;
  onComplete: (cost?: number, duration?: number) => void;
  onError: (error: Error) => void;
}

/**
 * Controller for cancelling a running agent query
 */
export interface AgentController {
  cancel: () => void;
}

/**
 * Build the unified system prompt for Heimdall
 */
function buildSystemPrompt(config: HeimdallConfig): string {
  const namespaceScope = config.namespace === 'all' 
    ? 'all namespaces' 
    : `namespace: ${config.namespace}`;
  
  const namespaceFlag = config.namespace === 'all' ? '-A' : `-n ${config.namespace}`;

  return `You are Heimdall, an expert Kubernetes assistant and SRE agent.

## Current Connection
- Cluster context: ${config.context}
- Namespace scope: ${namespaceScope}

## IMPORTANT: Answer the Specific Question
- Focus ONLY on what the user asks. Do NOT run a full health check unless explicitly requested.
- If user asks about PDBs, only check PDBs. If user asks about pods, only check pods.
- Be efficient - run the minimum commands needed to answer the question.
- Do NOT check nodes, events, or other resources unless directly relevant to the question.

## CRITICAL SAFETY RULES
You are in READ-ONLY mode. You must NEVER execute commands that modify the cluster:
- FORBIDDEN: kubectl create, apply, delete, patch, edit, replace, scale, rollout, drain, cordon, taint
- FORBIDDEN: helm install, upgrade, uninstall, rollback
- FORBIDDEN: Any command that creates, updates, or deletes resources

If the user asks to fix something, provide the command as a SUGGESTION they can run manually.

## Allowed Commands (READ-ONLY)
- kubectl get, describe, logs, top, explain, api-resources, version
- helm list, status, get, history
- Any command that only reads data

## Command Format
Always use: kubectl --context=${config.context} for all commands.
For namespace-scoped resources, use: ${namespaceFlag}

## Response Style
- Be concise and actionable
- Summarize findings clearly and highlight issues
- When fixes are needed, suggest commands but DO NOT execute them

## Web Search Capabilities
You have access to web search tools for enhanced diagnostics:
- **WebSearch**: Search for error messages, known issues, CVEs, or best practices
- **WebFetch**: Fetch official Kubernetes docs, GitHub issues, or release notes

Use web search when:
- You encounter unfamiliar error messages or codes
- Checking for known issues or CVEs related to specific versions
- Looking up deprecated APIs or migration guides`;
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

/**
 * Run any K8s query through the agent
 * The LLM decides what to check based on the user's request
 * Returns a controller that can be used to cancel the query
 */
export async function runAgentQuery(
  queryText: string,
  options: AgentRunnerOptions,
  callbacks: AgentRunnerCallbacks,
  context?: ConversationContext
): Promise<AgentController> {
  const { config, model, verbose } = options;
  const systemPrompt = buildSystemPrompt(config);

  // Include conversation history for follow-ups
  let fullQuery = queryText;
  if (context && !context.isEmpty()) {
    const history = context.getHistory();
    fullQuery = `Previous conversation:\n${history}\n\nNew question: ${queryText}`;
  }

  context?.addTurn('user', queryText);

  return runAgentStream(fullQuery, systemPrompt, model, verbose, callbacks, context);
}

/**
 * Internal function to run the agent stream
 * Returns a controller for cancellation
 */
async function runAgentStream(
  userPrompt: string,
  systemPrompt: string,
  model: string,
  verbose: boolean | undefined,
  callbacks: AgentRunnerCallbacks,
  context?: ConversationContext
): Promise<AgentController> {
  const queryOptions = {
    allowedTools: ['Bash', 'WebSearch', 'WebFetch'],
    systemPrompt,
    permissionMode: 'bypassPermissions' as const,
    model,
    persistSession: false,
  };

  const messageQueue = new UserMessageQueue();
  messageQueue.enqueue(createUserMessage(userPrompt));

  let assistantBuffer = '';
  let cancelled = false;
  let queryStream: ReturnType<typeof query> | null = null;

  // Start the query in the background
  const runQuery = async () => {
    try {
      queryStream = query({ prompt: messageQueue, options: queryOptions });

      for await (const message of queryStream) {
        if (cancelled) {
          break;
        }

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
                const inp = block.input as { command?: string; description?: string; query?: string; url?: string };
                // Build details string based on tool type
                let details: string | undefined;
                if (inp?.command) {
                  details = `$ ${inp.command}`;
                } else if (inp?.query) {
                  details = `🔍 "${inp.query}"`;
                } else if (inp?.url) {
                  details = `🌐 ${inp.url}`;
                }
                callbacks.onToolUse(block.name || 'unknown', details);
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
      if (!cancelled) {
        callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };

  // Start the query
  runQuery();

  // Return controller for cancellation
  return {
    cancel: () => {
      cancelled = true;
      messageQueue.close();
      if (queryStream && typeof (queryStream as { interrupt?: () => Promise<void> }).interrupt === 'function') {
        (queryStream as { interrupt: () => Promise<void> }).interrupt().catch(() => {});
      }
      callbacks.onMessage({
        id: generateMessageId(),
        type: 'system',
        content: '⚠️ Query cancelled by user',
        timestamp: new Date(),
      });
      callbacks.onComplete();
    },
  };
}
