import { query } from '@anthropic-ai/claude-agent-sdk';
import type { HeimdallConfig } from './types.js';
import {
  createPreToolUseHook,
  createPreCompactHook,
  DEFAULT_MAX_TURNS,
  type OnCommandBlockedCallback,
  type OnCompactionCallback,
  type HookOutput,
} from './safetyHooks.js';

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
    sessionId?: string;
  };
}

export interface AgentRunnerOptions {
  config: HeimdallConfig;
  model: string;
  verbose?: boolean;
  /** Resume a specific session by ID */
  resumeSessionId?: string;
  /** Maximum turns before termination (default: 15, 0 or negative = unlimited) */
  maxTurns?: number;
  /** Enable safety hooks for blocking destructive commands (default: true) */
  enableSafetyHooks?: boolean;
}

export interface AgentRunnerCallbacks {
  onMessage: (message: OutputMessage) => void;
  onToolUse: (toolName: string, details?: string) => void;
  onComplete: (cost?: number, duration?: number, sessionId?: string) => void;
  onError: (error: Error) => void;
  onSessionId?: (sessionId: string) => void;
  /** Called when a destructive command is blocked */
  onCommandBlocked?: (command: string, reason: string) => void;
  /** Called when context compaction occurs */
  onCompaction?: (trigger: 'auto' | 'manual') => void;
  /** Called on each turn with current count and max */
  onTurnCount?: (turnCount: number, maxTurns: number) => void;
}

/**
 * Controller for cancelling a running agent query
 */
export interface AgentController {
  cancel: () => void;
}

/**
 * Session info for display
 */
export interface SessionInfo {
  sessionId: string;
  startTime: Date;
  turnCount: number;
}

// Current session ID (managed by SDK)
let currentSessionId: string | null = null;

/**
 * Get current session ID
 */
export function getCurrentSessionId(): string | null {
  return currentSessionId;
}

/**
 * Clear current session (for /new command)
 */
export function clearCurrentSession(): void {
  currentSessionId = null;
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
- Looking up deprecated APIs or migration guides

## Specialized Subagents
You can delegate complex tasks to specialized subagents using the Task tool:
- **log-analyzer**: Deep log analysis, error correlation, pattern detection
- **resource-analyzer**: CPU/memory analysis, capacity planning, resource optimization
- **network-debugger**: DNS, services, ingress, connectivity troubleshooting
- **security-auditor**: RBAC, secrets, security contexts, policy review
- **web-researcher**: CVE lookup, documentation search, best practices

Delegate when the task requires deep specialized analysis. The subagent will return findings to you.`;
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
 * Options passed to the Claude Agent SDK query function.
 * Defines the structure for type safety instead of Record<string, unknown>.
 */
interface SDKQueryOptions {
  allowedTools: string[];
  systemPrompt: string;
  permissionMode: 'bypassPermissions' | 'default';
  model: string;
  persistSession: boolean;
  resume?: string;
  maxTurns?: number;
  agents?: Record<string, AgentDefinition>;
  hooks?: {
    PreToolUse?: Array<{
      matcher?: string;
      hooks: Array<(input: unknown, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<HookOutput>>;
      timeout?: number;
    }>;
    PreCompact?: Array<{
      matcher?: string;
      hooks: Array<(input: unknown, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<HookOutput>>;
      timeout?: number;
    }>;
  };
}

/**
 * Agent definition for SDK's built-in subagent support
 */
interface AgentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  maxTurns?: number;
}

/**
 * Build specialized subagent definitions for Heimdall
 * Claude will automatically delegate to these when appropriate
 */
function buildAgentDefinitions(config: HeimdallConfig): Record<string, AgentDefinition> {
  const namespaceFlag = config.namespace === 'all' ? '-A' : `-n ${config.namespace}`;
  
  return {
    'log-analyzer': {
      description: 'Specialized in analyzing pod logs, finding errors, correlating timestamps, and identifying patterns in log output',
      prompt: `You are a log analysis specialist for Kubernetes.

## Your Focus
- Analyze pod logs for errors, warnings, and anomalies
- Correlate timestamps across multiple pods
- Identify patterns and recurring issues
- Extract relevant stack traces and error messages

## Command Format
Always use: kubectl --context=${config.context} ${namespaceFlag}

## CRITICAL: READ-ONLY MODE
- ONLY use: kubectl logs, kubectl get events
- NEVER use: kubectl apply, delete, patch, create

## Response Style
- Highlight critical errors first
- Group related log entries
- Provide timeline of events when relevant`,
      tools: ['Bash'],
      model: 'inherit',
      maxTurns: 10,
    },
    
    'resource-analyzer': {
      description: 'Specialized in analyzing resource usage, requests/limits, capacity planning, and identifying resource bottlenecks',
      prompt: `You are a Kubernetes resource analysis specialist.

## Your Focus
- Analyze CPU and memory requests/limits
- Identify over-provisioned or under-provisioned workloads
- Check node capacity and utilization
- Find resource quota issues

## Command Format
Always use: kubectl --context=${config.context} ${namespaceFlag}

## CRITICAL: READ-ONLY MODE
- ONLY use: kubectl top, kubectl describe, kubectl get
- NEVER use: kubectl apply, delete, patch, create, scale

## Response Style
- Present resource data in clear format
- Highlight misconfigurations
- Suggest optimal resource values`,
      tools: ['Bash'],
      model: 'inherit',
      maxTurns: 10,
    },
    
    'network-debugger': {
      description: 'Specialized in debugging network issues including DNS, services, endpoints, ingress, and connectivity problems',
      prompt: `You are a Kubernetes network debugging specialist.

## Your Focus
- Debug DNS resolution issues
- Check service endpoints and selectors
- Analyze ingress configurations
- Verify network policies
- Test connectivity between pods

## Command Format
Always use: kubectl --context=${config.context} ${namespaceFlag}

## CRITICAL: READ-ONLY MODE
- ONLY use: kubectl get, describe, logs
- NEVER use: kubectl apply, delete, patch, create

## Response Style
- Trace network path step by step
- Identify where connectivity breaks
- Explain DNS resolution chain`,
      tools: ['Bash'],
      model: 'inherit',
      maxTurns: 10,
    },
    
    'security-auditor': {
      description: 'Specialized in auditing RBAC, secrets, security contexts, network policies, and identifying security misconfigurations',
      prompt: `You are a Kubernetes security audit specialist.

## Your Focus
- Audit RBAC roles and bindings
- Check for overly permissive service accounts
- Review security contexts and pod security
- Analyze network policies
- Identify exposed secrets or sensitive data

## Command Format
Always use: kubectl --context=${config.context} ${namespaceFlag}

## CRITICAL: READ-ONLY MODE
- ONLY use: kubectl get, describe, auth can-i
- NEVER use: kubectl apply, delete, patch, create
- NEVER expose actual secret values

## Response Style
- List security findings by severity
- Explain the risk of each finding
- Suggest remediation steps (but don't execute)`,
      tools: ['Bash'],
      model: 'inherit',
      maxTurns: 10,
    },
    
    'web-researcher': {
      description: 'Specialized in searching for CVEs, known issues, best practices, and official documentation for Kubernetes problems',
      prompt: `You are a Kubernetes research specialist.

## Your Focus
- Search for CVEs related to specific versions
- Find known issues and workarounds
- Look up official documentation
- Research best practices and recommendations

## Tools Available
- WebSearch: Search for information
- WebFetch: Fetch specific documentation pages

## Response Style
- Cite sources for all findings
- Prioritize official documentation
- Note version-specific information`,
      tools: ['WebSearch', 'WebFetch'],
      model: 'inherit',
      maxTurns: 8,
    },
  };
}

/**
 * Build hooks configuration for SDK query
 */
function buildHooksConfig(
  enableSafetyHooks: boolean,
  onCommandBlocked?: OnCommandBlockedCallback,
  onCompaction?: OnCompactionCallback
): SDKQueryOptions['hooks'] {
  const hooks: SDKQueryOptions['hooks'] = {};

  if (enableSafetyHooks) {
    hooks.PreToolUse = [
      {
        matcher: 'Bash',
        hooks: [createPreToolUseHook(onCommandBlocked)],
      },
    ];
  }

  if (onCompaction) {
    hooks.PreCompact = [
      {
        hooks: [createPreCompactHook(onCompaction)],
      },
    ];
  }

  return Object.keys(hooks).length > 0 ? hooks : undefined;
}

/**
 * Build complete SDK query options
 */
function buildQueryOptions(
  systemPrompt: string,
  model: string,
  options: AgentRunnerOptions,
  callbacks: AgentRunnerCallbacks
): SDKQueryOptions {
  const enableSafetyHooks = options.enableSafetyHooks !== false; // Default true
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;

  const queryOptions: SDKQueryOptions = {
    allowedTools: ['Bash', 'WebSearch', 'WebFetch', 'Task'], // Task tool enables subagent delegation
    systemPrompt,
    permissionMode: 'bypassPermissions',
    model,
    persistSession: true,
    agents: buildAgentDefinitions(options.config),
  };

  // Add maxTurns if positive
  if (maxTurns > 0) {
    queryOptions.maxTurns = maxTurns;
  }

  // Add hooks
  const hooks = buildHooksConfig(
    enableSafetyHooks,
    callbacks.onCommandBlocked
      ? (cmd, reason, _suggested) => callbacks.onCommandBlocked!(cmd, reason)
      : undefined,
    callbacks.onCompaction
  );
  if (hooks) {
    queryOptions.hooks = hooks;
  }

  // Resume specific session if provided
  if (options.resumeSessionId) {
    queryOptions.resume = options.resumeSessionId;
  }

  return queryOptions;
}

/**
 * Run any K8s query through the agent
 * The LLM decides what to check based on the user's request
 * Returns a controller that can be used to cancel the query
 */
export async function runAgentQuery(
  queryText: string,
  options: AgentRunnerOptions,
  callbacks: AgentRunnerCallbacks
): Promise<AgentController> {
  const { config, model, verbose } = options;
  const systemPrompt = buildSystemPrompt(config);

  return runAgentStream(queryText, systemPrompt, model, verbose, callbacks, options);
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
  options: AgentRunnerOptions
): Promise<AgentController> {
  // Build query options with all enhancements
  const queryOptions = buildQueryOptions(systemPrompt, model, options, callbacks);
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;

  const messageQueue = new UserMessageQueue();
  messageQueue.enqueue(createUserMessage(userPrompt));

  let assistantBuffer = '';
  let cancelled = false;
  let turnCount = 0;
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

          // Capture session ID from init message
          if (msg.type === 'system' && msg.subtype === 'init') {
            const sessionId = msg.session_id as string | undefined;
            if (sessionId) {
              currentSessionId = sessionId;
              callbacks.onSessionId?.(sessionId);
            }
            callbacks.onMessage({
              id: generateMessageId(),
              type: 'system',
              content: `Agent initialized with model: ${msg.model}`,
              timestamp: new Date(),
              metadata: { sessionId },
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
                
                // Track turns (each tool use is a turn)
                turnCount++;
                if (maxTurns > 0) {
                  callbacks.onTurnCount?.(turnCount, maxTurns);
                }
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

            callbacks.onComplete(cost, duration, currentSessionId || undefined);
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
