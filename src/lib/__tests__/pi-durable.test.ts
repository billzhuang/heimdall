import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  AssistantEntry,
  MemoryStorage,
  UserEntry,
  type ToolExecutionApi,
} from '@earendil-works/pi-durable';
import type { JsonValue } from '@earendil-works/chord';
import {
  createFlueClient,
  createSessionClient,
  defineAgent,
  defineAgentProfile,
  defineTool,
  defineWorkflow,
  extractAssistantText,
  isValibotSchema,
  parseModelRef,
  schemaToJsonParameters,
} from '../pi-durable.ts';

describe('isValibotSchema', () => {
  it('returns true for a Valibot object schema', () => {
    const schema = v.object({ name: v.string() });
    expect(isValibotSchema(schema)).toBe(true);
  });

  it('returns false for primitives, null, and plain JSON Schema objects', () => {
    expect(isValibotSchema(null)).toBe(false);
    expect(isValibotSchema(undefined)).toBe(false);
    expect(isValibotSchema('string')).toBe(false);
    expect(isValibotSchema({ type: 'object', properties: {} })).toBe(false);
  });
});

describe('schemaToJsonParameters', () => {
  it('converts a Valibot schema into a JSON Schema object with properties and required', () => {
    const schema = v.object({
      args: v.string(),
      context: v.optional(v.string()),
    });
    const params = schemaToJsonParameters(schema);
    expect(params.type).toBe('object');
    expect(params.properties).toHaveProperty('args');
    expect(params.properties).toHaveProperty('context');
    expect(params.required).toEqual(['args']);
  });

  it('preserves properties and required from a raw JSON Schema object', () => {
    const raw = {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    };
    const params = schemaToJsonParameters(raw);
    expect(params).toEqual(raw);
  });

  it('falls back to bare { type: "object" } when Valibot conversion throws or input is non-object', () => {
    const brokenValibot = { kind: 'schema', type: 'unknown-custom-type' };
    expect(schemaToJsonParameters(brokenValibot)).toEqual({ type: 'object' });
    expect(schemaToJsonParameters(null)).toEqual({ type: 'object' });
  });
});

describe('defineTool', () => {
  it('creates a Pi Durable tool registration with replay="safe" by default and executes via both .run() and .execute()', async () => {
    const tool = defineTool({
      name: 'echo_tool',
      description: 'Echoes input text',
      input: v.object({ message: v.string() }),
      run: async ({ input }) => `echo: ${input.message}`,
    });

    expect(tool.name).toBe('echo_tool');
    expect(tool.description).toBe('Echoes input text');
    expect(tool.replay).toBe('safe');
    expect(tool.parameters.type).toBe('object');

    const directResult = await tool.run({ input: { message: 'hello' } });
    expect(directResult).toBe('echo: hello');

    const durableResult = await tool.execute(
      { message: 'durable' },
      {} as unknown as ToolExecutionApi<JsonValue>,
      BACKGROUND_CONTEXT,
    );
    expect(durableResult.output).toEqual([{ type: 'text', text: 'echo: durable' }]);
  });

  it('respects explicit replay="unsafe" and stringifies non-string run return values', async () => {
    const tool = defineTool({
      name: 'raw_tool',
      description: 'Returns non-string',
      input: { type: 'object' },
      replay: 'unsafe',
      run: (() => ({ ok: true }) as unknown as string),
    });

    expect(tool.replay).toBe('unsafe');
    expect(await tool.run({ input: {} })).toBe('{"ok":true}');

    const unboundExecute = tool.execute.bind(undefined);
    const durableResult = await unboundExecute(
      undefined as unknown as Record<string, unknown>,
      {} as unknown as ToolExecutionApi<JsonValue>,
      BACKGROUND_CONTEXT,
    );
    expect(durableResult.output).toEqual([{ type: 'text', text: '{"ok":true}' }]);
  });

  it('delegates .execute() through a wrapped .run() method (e.g. telemetry timing wrapper)', async () => {
    const baseTool = defineTool({
      name: 'timed_tool',
      description: 'Timed tool',
      input: v.object({ q: v.string() }),
      run: async ({ input }) => `result:${input.q}`,
    });

    const spy = vi.fn();
    const wrapped = Object.assign({}, baseTool, {
      run: async (ctx: Parameters<typeof baseTool.run>[0]) => {
        spy(ctx.input);
        return baseTool.run(ctx);
      },
    });

    const execOut = await wrapped.execute(
      { q: 'pods' },
      {} as unknown as ToolExecutionApi<JsonValue>,
      BACKGROUND_CONTEXT,
    );
    expect(spy).toHaveBeenCalledWith({ q: 'pods' });
    expect(execOut.output).toEqual([{ type: 'text', text: 'result:pods' }]);
  });
});

describe('parseModelRef', () => {
  it('splits provider/modelId correctly', () => {
    expect(parseModelRef('anthropic/claude-sonnet-4-6')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
    });
    expect(parseModelRef('openai/gpt-5')).toEqual({
      provider: 'openai',
      modelId: 'gpt-5',
    });
  });

  it('defaults provider to anthropic when no slash or malformed slash is given', () => {
    expect(parseModelRef('claude-sonnet-4-6')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
    });
    expect(parseModelRef('/leading-slash')).toEqual({
      provider: 'anthropic',
      modelId: '/leading-slash',
    });
    expect(parseModelRef('trailing-slash/')).toEqual({
      provider: 'anthropic',
      modelId: 'trailing-slash/',
    });
  });
});

describe('defineAgentProfile & defineAgent', () => {
  const sampleTool = defineTool({
    name: 'sample_kubectl',
    description: 'Sample read-only kubectl',
    input: v.object({ args: v.string() }),
    run: async ({ input }) => `kubectl ${input.args}`,
  });

  const subagent = defineAgentProfile({
    name: 'incident-investigator',
    description: 'Investigates pod crashes',
    model: 'anthropic/claude-sonnet-4-6',
    instructions: 'Check pod logs and events.',
    tools: [sampleTool],
  });

  it('builds a Pi Durable extension for subagent profiles and agents', () => {
    expect(subagent.extension.name).toBe('heimdall-subagent-incident-investigator');
    expect(subagent.extension.tools).toHaveLength(1);

    const agent = defineAgent(() => ({
      name: 'custom-heimdall',
      model: 'anthropic/claude-sonnet-4-6',
      instructions: 'You are Heimdall.',
      tools: [sampleTool],
      subagents: [subagent],
    }));

    const runtime = agent.initialize();
    expect(runtime.extension.name).toBe('custom-heimdall');
    expect(runtime.tools).toEqual([sampleTool]);
    expect(runtime.subagents).toEqual([subagent]);
  });

  it('supports static config objects in defineAgent without subagents', () => {
    const staticAgent = defineAgent({
      model: 'anthropic/claude-sonnet-4-6',
      instructions: 'Static instructions.',
      tools: [sampleTool],
    });
    const runtime = staticAgent.initialize();
    expect(runtime.extension.name).toBe('heimdall');
  });

  it('opens a Pi Durable Harness with MemoryStorage and configures the root conversation', async () => {
    const agent = defineAgent(() => ({
      model: 'anthropic/claude-sonnet-4-6',
      instructions: 'You are Heimdall.',
      tools: [sampleTool],
      subagents: [subagent],
    }));

    const { harness, conversation, storage } = await agent.openHarness({
      storage: new MemoryStorage(),
      model: 'anthropic/claude-opus-4-8',
    });

    try {
      expect(storage).toBeInstanceOf(MemoryStorage);
      const resolvedAgent = await conversation.agent(BACKGROUND_CONTEXT);
      expect(resolvedAgent.model).toEqual({
        provider: 'anthropic',
        modelId: 'claude-opus-4-8',
      });
      expect(resolvedAgent.tools.map((t) => t.name)).toContain('sample_kubectl');

      // Verify extractAssistantText when conversation has no assistant entries yet
      expect(await extractAssistantText(conversation, BACKGROUND_CONTEXT)).toBe('');

      // Append a user entry and an assistant entry in a transaction and verify extractAssistantText
      await conversation.commit(async (tx) => {
        await tx.appendEntry(conversation.id, {
          kind: UserEntry.kind,
          model: [{ role: 'user', content: 'Why is api crash-looping?', timestamp: Date.now() }],
        });
        await tx.appendEntry(conversation.id, {
          kind: AssistantEntry.kind,
          model: [
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Thinking Summary:\n- Pod OOMKilled' },
                { type: 'text', text: 'Answer:\nIncrease memory limit.' },
              ],
              api: 'anthropic-messages',
              provider: 'anthropic',
              model: 'claude-opus-4-8',
              usage: {
                input: 10,
                output: 20,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 30,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: 'stop',
              timestamp: Date.now(),
            },
          ],
        });
      }, BACKGROUND_CONTEXT);

      const extracted = await extractAssistantText(conversation, BACKGROUND_CONTEXT);
      expect(extracted).toBe('Thinking Summary:\n- Pod OOMKilled\nAnswer:\nIncrease memory limit.');
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });

  it('opens a Pi Durable Harness backed by openNodeSqliteStorage when sqlitePath is provided', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'heimdall-pi-sqlite-'));
    const sqlitePath = join(tmpDir, 'session.sqlite');
    const agent = defineAgent({
      model: 'anthropic/claude-sonnet-4-6',
      instructions: 'Durable SQLite agent.',
      tools: [sampleTool],
    });

    try {
      const { harness, conversation } = await agent.openHarness({ sqlitePath });
      try {
        const resolved = await conversation.agent(BACKGROUND_CONTEXT);
        expect(resolved.tools.map((t) => t.name)).toEqual(['sample_kubectl']);
      } finally {
        await harness.close(BACKGROUND_CONTEXT);
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws a descriptive error in agent.prompt() when a Pi Durable run settles unanswered (e.g. no_model)', async () => {
    const agent = defineAgent({
      model: 'unknown-provider/nonexistent-model',
      instructions: 'Test unanswered run.',
      tools: [sampleTool],
    });

    await expect(
      agent.prompt('Diagnose cluster', { model: 'unknown-provider/nonexistent-model' }),
    ).rejects.toThrow(/Pi Durable run ended unanswered \(no_model/);
  });
});

describe('defineWorkflow', () => {
  it('validates input with Valibot and executes the workflow against the harness session', async () => {
    const agent = defineAgent({
      model: 'anthropic/claude-sonnet-4-6',
      instructions: 'Workflow test agent',
      tools: [],
    });

    const workflow = defineWorkflow({
      agent,
      input: v.object({
        namespace: v.optional(v.string(), 'default'),
      }),
      run: async ({ harness, input }) => {
        const session = await harness.session();
        const res = await session.prompt(`Sweep namespace ${input.namespace}`);
        return { report: res.text };
      },
    });

    const customHarness = {
      session: async () => ({
        prompt: async (msg: string) => ({ text: `Report for: ${msg}` }),
      }),
    };

    const out = await workflow.execute({ namespace: 'prod' }, { harness: customHarness });
    expect(out).toEqual({ report: 'Report for: Sweep namespace prod' });

    const defaultOut = await workflow.execute(undefined, { harness: customHarness });
    expect(defaultOut).toEqual({ report: 'Report for: Sweep namespace default' });

    // Also test default harness creation when options.harness is omitted
    const promptSpy = vi.spyOn(agent, 'prompt').mockResolvedValueOnce({ text: 'Default harness report' });
    const autoHarnessOut = await workflow.execute({ namespace: 'kube-system' });
    expect(autoHarnessOut).toEqual({ report: 'Default harness report' });
    expect(promptSpy).toHaveBeenCalledWith('Sweep namespace kube-system', {});
    promptSpy.mockRestore();
  });
});

describe('createSessionClient / createFlueClient', () => {
  it('sends POST /api/diagnose with X-Heimdall-Session-Id and extracts answer or result.text', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ answer: 'Pod is OOMKilled', severity: 'critical' }),
    });

    const client = createSessionClient({
      baseUrl: 'http://localhost:3583/',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    const res = await client.agents.prompt('heimdall', 'sess-42', {
      message: 'check pods',
    });

    expect(res).toEqual({ result: { text: 'Pod is OOMKilled' } });
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3583/api/diagnose', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Heimdall-Session-Id': 'sess-42',
      },
      body: JSON.stringify({ prompt: 'check pods' }),
    });
  });

  it('supports result.text and summary fallbacks and throws on non-2xx HTTP responses', async () => {
    const fetchResultText = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ result: { text: 'from result.text' } }),
    });
    const client1 = createFlueClient({
      baseUrl: 'http://localhost:3000',
      fetchFn: fetchResultText as unknown as typeof fetch,
    });
    expect(
      await client1.agents.prompt('heimdall', 's1', { message: 'hi' }),
    ).toEqual({ result: { text: 'from result.text' } });

    const fetchError = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      text: async () => 'upstream error',
    });
    const client2 = createSessionClient({
      baseUrl: 'http://localhost:3000',
      fetchFn: fetchError as unknown as typeof fetch,
    });
    await expect(
      client2.agents.prompt('heimdall', 's1', { message: 'hi' }),
    ).rejects.toThrow('HTTP 502 Bad Gateway: upstream error');
  });
});
