/**
 * Pi Durable runtime integration for Heimdall.
 *
 * Bridges Heimdall's Valibot-typed read-only tools, agents, subagent profiles,
 * workflows, and multi-turn session client onto `@earendil-works/pi-durable`,
 * `@earendil-works/pi-ai`, and `@earendil-works/chord`.
 *
 * Every Heimdall tool is read-only by construction and therefore registered
 * with `replay: 'safe'` in Pi Durable so interrupted tool executions safely
 * replay across process restarts.
 */
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool as piDefineTool,
  Harness,
  MemoryStorage,
  section,
  type Conversation,
  type Extension,
  type ModelRef,
  type Storage,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { Models } from '@earendil-works/pi-ai/models';
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord';
import * as v from 'valibot';
import { toJsonSchema } from '@valibot/to-json-schema';
import { DEFAULT_MODEL } from './model.ts';

export type ValibotSchema = v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>;

/** Execution context passed to a Heimdall tool's `run` function. */
export interface ToolRunContext<TInput = Record<string, unknown>> {
  input: TInput;
  signal?: AbortSignal;
}

/** Options accepted by {@link defineTool}. */
export interface DefineToolOptions<
  TSchema extends ValibotSchema | Record<string, unknown>,
  TInput = TSchema extends ValibotSchema ? v.InferOutput<TSchema> : Record<string, unknown>,
> {
  name: string;
  description: string;
  input: TSchema;
  /** Crash-recovery replay policy in Pi Durable. Defaults to `'safe'` for read-only SRE tools. */
  replay?: 'safe' | 'unsafe';
  run: (context: ToolRunContext<TInput>) => Promise<string> | string;
}

/**
 * A Heimdall tool definition that is both a Pi Durable `ToolRegistration`
 * and directly callable via `.run({ input, signal })` for MCP and unit tests.
 */
export interface ToolDefinition<
  TSchema extends ValibotSchema | Record<string, unknown> = ValibotSchema | Record<string, unknown>,
  TInput = TSchema extends ValibotSchema ? v.InferOutput<TSchema> : Record<string, unknown>,
> extends ToolRegistration<Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly input: TSchema;
  readonly parameters: Record<string, unknown>;
  readonly replay: 'safe' | 'unsafe';
  // Method syntax allows bivariant assignment from concrete tool schemas into ToolDefinition arrays/maps.
  run(context: ToolRunContext<TInput>): Promise<string>;
}

/** Detects whether `input` is a Valibot schema object (`kind === 'schema'`). */
export function isValibotSchema(input: unknown): input is ValibotSchema {
  return (
    typeof input === 'object' &&
    input !== null &&
    'kind' in input &&
    (input as { kind: unknown }).kind === 'schema'
  );
}

/**
 * Convert a Valibot schema or raw JSON Schema object into a clean JSON Schema
 * `parameters` object suitable for Pi Durable's validator and MCP tool listing.
 */
export function schemaToJsonParameters(input: unknown): {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
} {
  let raw: Record<string, unknown> = {};
  if (isValibotSchema(input)) {
    try {
      raw = toJsonSchema(input) as Record<string, unknown>;
    } catch {
      raw = {};
    }
  } else if (typeof input === 'object' && input !== null) {
    raw = input as Record<string, unknown>;
  }

  return {
    type: 'object',
    ...(raw.properties !== undefined && {
      properties: raw.properties as Record<string, unknown>,
    }),
    ...(Array.isArray(raw.required) && { required: raw.required as string[] }),
  };
}

/**
 * Define a Pi Durable tool from a Valibot input schema and an async `run` handler.
 */
export function defineTool<
  TSchema extends ValibotSchema | Record<string, unknown>,
  TInput = TSchema extends ValibotSchema ? v.InferOutput<TSchema> : Record<string, unknown>,
>(options: DefineToolOptions<TSchema, TInput>): ToolDefinition<TSchema, TInput> {
  const parameters = schemaToJsonParameters(options.input);
  const replay = options.replay ?? 'safe';

  const runFn = async (ctx: ToolRunContext<TInput>): Promise<string> => {
    const out = await options.run(ctx);
    return typeof out === 'string' ? out : JSON.stringify(out ?? '');
  };

  const toolObj: ToolDefinition<TSchema, TInput> = {
    ...piDefineTool({
      name: options.name,
      description: options.description,
      parameters,
      replay,
      execute: async function (
        this: ToolDefinition<TSchema, TInput>,
        args: unknown,
        _api: ToolExecutionApi<JsonValue>,
        context: Context,
      ): Promise<ToolExecutionResult<JsonValue>> {
        const activeRun = typeof this?.run === 'function' ? this.run.bind(this) : runFn;
        const text = await activeRun({
          input: (args ?? {}) as TInput,
          signal: context?.abortSignal,
        });
        return {
          output: [{ type: 'text', text }],
        };
      },
    }),
    input: options.input,
    parameters,
    replay,
    run: runFn,
  };

  return toolObj;
}

/** Parse a `"provider/modelId"` string into a Pi Durable {@link ModelRef}. */
export function parseModelRef(modelSpec: string): ModelRef {
  const slashIndex = modelSpec.indexOf('/');
  if (slashIndex <= 0 || slashIndex === modelSpec.length - 1) {
    return { provider: 'anthropic', modelId: modelSpec };
  }
  return {
    provider: modelSpec.slice(0, slashIndex),
    modelId: modelSpec.slice(slashIndex + 1),
  };
}

/** Configuration for a specialist subagent profile. */
export interface AgentProfileConfig {
  name: string;
  description: string;
  model: string;
  instructions: string;
  tools: ToolDefinition[];
}

/** A defined subagent profile backed by a Pi Durable extension. */
export interface AgentProfile extends AgentProfileConfig {
  readonly extension: Extension<ToolDefinition>;
}

/** Define a specialist subagent profile for Heimdall. */
export function defineAgentProfile(config: AgentProfileConfig): AgentProfile {
  const extension = defineExtension<ToolDefinition>({
    name: `heimdall-subagent-${config.name}`,
    tools: config.tools,
    sections: [
      section<ToolDefinition>(`subagent-${config.name}`, () => config.instructions, { tag: false }),
    ],
  });
  return {
    ...config,
    extension,
  };
}

/** Configuration returned by an agent initializer. */
export interface AgentConfig {
  name?: string;
  model: string;
  instructions: string;
  tools: ToolDefinition[];
  subagents?: AgentProfile[];
}

/** Materialized runtime configuration of a {@link DefinedAgent}. */
export interface InitializedAgent extends AgentConfig {
  readonly extension: Extension<ToolDefinition>;
}

/** Options when opening a Pi Durable {@link Harness} for a {@link DefinedAgent}. */
export interface OpenHarnessOptions {
  /** Custom Pi Durable storage (defaults to `MemoryStorage`, or `openNodeSqliteStorage(sqlitePath)`). */
  storage?: Storage;
  /** Optional SQLite file path for durable local persistence via `node:sqlite`. */
  sqlitePath?: string;
  /** Override model in `"provider/model"` format. */
  model?: string;
  /** Custom Pi AI `Models` catalog (defaults to `builtinModels()`). */
  models?: Models | (() => Models);
  /** Execution context (defaults to `BACKGROUND_CONTEXT`). */
  context?: Context;
}

/** Options for running a single prompt against a {@link DefinedAgent}. */
export interface RunAgentPromptOptions extends OpenHarnessOptions {
  signal?: AbortSignal;
}

/** A defined Pi Durable agent. */
export interface DefinedAgent {
  initialize(): InitializedAgent;
  openHarness(options?: OpenHarnessOptions): Promise<{
    harness: Harness;
    conversation: Conversation;
    storage: Storage;
    runtime: InitializedAgent;
  }>;
  prompt(message: string, options?: RunAgentPromptOptions): Promise<{ text: string }>;
}

/**
 * Extract the text of the latest assistant response from a conversation's entries.
 */
export async function extractAssistantText(
  conversation: Conversation,
  context: Context = BACKGROUND_CONTEXT,
): Promise<string> {
  const page = await conversation.entries({ order: 'descending' }, 50, undefined, context);
  for (const entry of page.items) {
    if (AssistantEntry.is(entry) && entry.model && entry.model.length > 0) {
      const msg = entry.model[0];
      if (msg && msg.role === 'assistant' && Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((part): part is { type: 'text'; text: string } => part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text);
        if (textParts.length > 0) {
          return textParts.join('\n');
        }
      }
    }
  }
  return '';
}

/**
 * Define a Pi Durable agent from an initializer function or static config.
 */
export function defineAgent(init: (() => AgentConfig) | AgentConfig): DefinedAgent {
  const initialize = (): InitializedAgent => {
    const cfg = typeof init === 'function' ? init() : init;
    const extName = cfg.name ?? 'heimdall';
    const subagentSummary =
      cfg.subagents && cfg.subagents.length > 0
        ? `\n\nAvailable specialist subagent profiles:\n` +
          cfg.subagents.map((s) => `- **${s.name}**: ${s.description}`).join('\n')
        : '';
    const fullInstructions = cfg.instructions + subagentSummary;
    const extension = defineExtension<ToolDefinition>({
      name: extName,
      tools: cfg.tools,
      sections: [
        section<ToolDefinition>('heimdall_system_prompt', () => fullInstructions, { tag: false }),
      ],
    });
    return {
      ...cfg,
      instructions: fullInstructions,
      extension,
    };
  };

  const openHarness = async (options: OpenHarnessOptions = {}) => {
    const runtime = initialize();
    const ctx = options.context ?? BACKGROUND_CONTEXT;
    const storage: Storage =
      options.storage ??
      (options.sqlitePath ? await openNodeSqliteStorage(options.sqlitePath) : new MemoryStorage());

    const registry = createRegistry<ToolDefinition>();
    registry.install(runtime.extension);
    for (const sub of runtime.subagents ?? []) {
      registry.install(sub.extension);
    }

    const harness = await Harness.open(
      storage,
      {
        models: options.models ?? builtinModels,
        registry,
      },
      ctx,
    );

    const modelSpec = options.model || runtime.model || DEFAULT_MODEL;
    const conversation = await harness.root(ctx, {
      agent: {
        model: parseModelRef(modelSpec),
        extensions: [runtime.extension],
        tools: runtime.tools,
        instructions: runtime.instructions,
      },
    });

    return { harness, conversation, storage, runtime };
  };

  const prompt = async (
    message: string,
    options: RunAgentPromptOptions = {},
  ): Promise<{ text: string }> => {
    const baseCtx = options.context ?? BACKGROUND_CONTEXT;
    const ctx = options.signal ? withAbortSignal(options.signal, baseCtx) : baseCtx;
    const { harness, conversation } = await openHarness({ ...options, context: ctx });
    try {
      const submission = await conversation.submit({ type: 'input', content: message }, ctx);
      const settled = await submission.wait(ctx);
      if (settled.status === 'unanswered') {
        const detail =
          settled.detail !== undefined
            ? `: ${typeof settled.detail === 'string' ? settled.detail : JSON.stringify(settled.detail)}`
            : '';
        throw new Error(`Pi Durable run ended unanswered (${settled.reason}${detail})`);
      }
      const text = await extractAssistantText(conversation, ctx);
      return { text };
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  };

  return {
    initialize,
    openHarness,
    prompt,
  };
}

/** Session handle exposed to a workflow's `run` function. */
export interface WorkflowSession {
  prompt(message: string): Promise<{ text: string }>;
}

/** Harness handle exposed to a workflow's `run` function. */
export interface WorkflowHarness {
  session(): Promise<WorkflowSession>;
}

/** Options accepted by {@link defineWorkflow}. */
export interface WorkflowConfig<
  TSchema extends ValibotSchema,
  TResult,
  TInput = v.InferOutput<TSchema>,
> {
  agent: DefinedAgent;
  input: TSchema;
  run: (ctx: { harness: WorkflowHarness; input: TInput }) => Promise<TResult>;
}

/** A defined Pi Durable workflow. */
export interface DefinedWorkflow<
  TSchema extends ValibotSchema,
  TResult,
  TInput = v.InferOutput<TSchema>,
> extends WorkflowConfig<TSchema, TResult, TInput> {
  execute(rawInput?: unknown, options?: RunAgentPromptOptions & { harness?: WorkflowHarness }): Promise<TResult>;
}

/**
 * Define a structured workflow backed by a Pi Durable {@link DefinedAgent}.
 */
export function defineWorkflow<
  TSchema extends ValibotSchema,
  TResult,
  TInput = v.InferOutput<TSchema>,
>(config: WorkflowConfig<TSchema, TResult, TInput>): DefinedWorkflow<TSchema, TResult, TInput> {
  return {
    ...config,
    async execute(
      rawInput?: unknown,
      options: RunAgentPromptOptions & { harness?: WorkflowHarness } = {},
    ): Promise<TResult> {
      const parsedInput = v.parse(config.input, rawInput ?? {}) as TInput;
      const harness: WorkflowHarness =
        options.harness ?? {
          session: async () => ({
            prompt: (message: string) => config.agent.prompt(message, options),
          }),
        };
      return config.run({ harness, input: parsedInput });
    },
  };
}

/** Options for {@link createSessionClient}. */
export interface SessionClientOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
}

/** Client for multi-turn durable debugging sessions. */
export interface SessionClient {
  agents: {
    prompt(
      agentName: string,
      sessionId: string,
      body: { message: string },
    ): Promise<{ result: { text: string } }>;
  };
}

/**
 * Create an HTTP client for interacting with a Heimdall server in session-mode.
 */
export function createSessionClient(options: SessionClientOptions): SessionClient {
  const fetchImpl = options.fetchFn ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');

  return {
    agents: {
      async prompt(
        _agentName: string,
        sessionId: string,
        body: { message: string },
      ): Promise<{ result: { text: string } }> {
        const response = await fetchImpl(`${base}/api/diagnose`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Heimdall-Session-Id': sessionId,
          },
          body: JSON.stringify({ prompt: body.message }),
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          throw new Error(
            `HTTP ${response.status} ${response.statusText}${errText ? `: ${errText}` : ''}`,
          );
        }

        const data = (await response.json()) as {
          result?: { text?: string };
          answer?: string;
          summary?: string;
        };
        const text = data?.result?.text ?? data?.answer ?? data?.summary ?? '';
        return { result: { text } };
      },
    },
  };
}

/** Backward-compatible alias for {@link createSessionClient}. */
export const createFlueClient = createSessionClient;
