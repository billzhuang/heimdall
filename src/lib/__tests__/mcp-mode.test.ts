import { describe, it, expect, vi } from 'vitest';
import * as v from 'valibot';

// Mock config so we don't need a real heimdall.config.yaml
vi.mock('../../lib/config.ts', () => ({
  loadConfig: () => ({
    tools: {
      kubectl: true,
      listContexts: true,
      listNamespaces: true,
      helmRelease: true,
      prometheusQuery: false,
      awsCli: false,
      trivyScan: false,
      kubecostQuery: false,
      lokiQuery: false,
      jaegerQuery: false,
      datadogQuery: false,
      newRelicQuery: false,
      cdkQuery: false,
    },
    redaction: null,
    namespace: null,
    audit: null,
    redactSecrets: false,
    prometheus: null,
    kubecost: null,
    loki: null,
    jaeger: null,
    datadog: null,
    newRelic: null,
    slos: [],
    runbooks: [],
    learning: null,
    telemetry: { enabled: false },
  }),
}));

// Use class syntax so `new Server(...)` works correctly
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class MockServer {
    setRequestHandler = vi.fn();
    connect = vi.fn();
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class MockTransport {},
}));
vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  ListToolsRequestSchema: { method: 'tools/list' },
  CallToolRequestSchema: { method: 'tools/call' },
}));

// Prevent any real binary execution in tests
vi.mock('../../lib/kubectl.ts', () => ({
  runKubectl: vi.fn().mockResolvedValue('mocked kubectl output'),
}));

import { parametersToInputSchema, createMcpServer, enabledTools } from '../../mcp-mode.ts';

describe('parametersToInputSchema', () => {
  it('converts a simple valibot object schema', () => {
    const schema = v.object({
      args: v.string(),
      context: v.optional(v.string()),
    });
    const result = parametersToInputSchema(schema);
    expect(result.type).toBe('object');
    expect(result.properties).toBeDefined();
    expect(result.properties).toHaveProperty('args');
    expect(result.properties).toHaveProperty('context');
  });

  it('marks required fields correctly for a valibot schema', () => {
    const schema = v.object({
      required_field: v.string(),
      optional_field: v.optional(v.string()),
    });
    const result = parametersToInputSchema(schema);
    expect(result.required).toContain('required_field');
    expect(result.required ?? []).not.toContain('optional_field');
  });

  it('falls back gracefully when given a raw JSON Schema object', () => {
    const rawSchema = {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'PromQL expression' },
      },
      required: ['query'],
    };
    const result = parametersToInputSchema(rawSchema);
    expect(result.type).toBe('object');
    expect(result.properties).toHaveProperty('query');
    expect(result.required).toContain('query');
  });

  it('returns bare { type: object } when parameters is undefined', () => {
    const result = parametersToInputSchema(undefined);
    expect(result.type).toBe('object');
    expect(result.properties).toBeUndefined();
    expect(result.required).toBeUndefined();
  });

  it('returns bare { type: object } for non-schema non-JSON-Schema input', () => {
    // string is neither a valibot schema nor a JSON Schema object — both conversion
    // paths fail or produce nothing useful, so the result is the bare type.
    const result = parametersToInputSchema('not-a-schema');
    expect(result.type).toBe('object');
  });
});

describe('createMcpServer', () => {
  it('initialises without throwing', () => {
    expect(() => createMcpServer()).not.toThrow();
  });

  it('registers both tools/list and tools/call handlers', () => {
    const server = createMcpServer();
    expect((server as unknown as { setRequestHandler: ReturnType<typeof vi.fn> }).setRequestHandler).toHaveBeenCalledTimes(2);
  });
});

describe('enabledTools', () => {
  it('only includes tools that are enabled in the mock config', () => {
    const names = enabledTools.map((t) => t.name);
    // These four are enabled in the mock config
    expect(names).toContain('kubectl');
    expect(names).toContain('list_contexts');
    expect(names).toContain('list_namespaces');
    expect(names).toContain('helm_release');
    // prometheusQuery is disabled in the mock config
    expect(names).not.toContain('prometheus_query');
    expect(names).not.toContain('aws_cli');
  });
});
