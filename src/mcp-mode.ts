/**
 * Heimdall MCP server mode.
 *
 * Exposes Heimdall's read-only Kubernetes diagnostic tools as an MCP server
 * so that Claude Desktop, Claude Code, Cursor, and other MCP-compatible
 * AI clients can call kubectl, helm, prometheus_query, etc. directly.
 *
 * Transport: stdio (compatible with Claude Desktop's claude_desktop_config.json).
 *
 * Quick start:
 *   npm run mcp
 *
 * Claude Desktop config (~/.config/claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "heimdall": {
 *         "command": "/path/to/heimdall/bin/heimdall",
 *         "args": ["mcp"]
 *       }
 *     }
 *   }
 *
 * Or with the pre-built bundle (after `npm run build`):
 *   {
 *     "mcpServers": {
 *       "heimdall": {
 *         "command": "node",
 *         "args": ["/path/to/heimdall/dist/mcp-mode.mjs"]
 *       }
 *     }
 *   }
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { toJsonSchema } from '@valibot/to-json-schema';
import type { ToolDefinition } from '@flue/runtime';
import { loadConfig } from './lib/config.ts';
import { compileRules } from './lib/regex-redact.ts';
import { makeKubectl } from './tools/kubectl.ts';
import { listContexts, makeListNamespaces } from './tools/kubeconfig.ts';
import { makeHelmRelease } from './tools/helm.ts';
import { makePrometheusQuery } from './tools/prometheus.ts';
import { makeAwsCli } from './tools/aws.ts';
import { makeTrivyScan } from './tools/trivy.ts';
import { makeKubecostQuery } from './tools/kubecost.ts';
import { makeLokiQuery } from './tools/loki.ts';
import { makeJaegerQuery } from './tools/jaeger.ts';
import { makeDatadogQuery } from './tools/datadog.ts';
import { makeNewRelicQuery } from './tools/newrelic.ts';
import { makeCdkQuery } from './tools/cdk.ts';
import type { HeimdallConfig } from './lib/config.ts';

const config = loadConfig();
const regexRedactionRules = config.redaction?.enabled
  ? compileRules(config.redaction.rules ?? [])
  : [];
const lockedNs = config.namespace?.locked;

const ALL_TOOLS: Record<keyof HeimdallConfig['tools'], ToolDefinition> = {
  kubectl: makeKubectl(config.audit, config.redactSecrets, regexRedactionRules, lockedNs),
  listContexts,
  listNamespaces: makeListNamespaces(lockedNs),
  helmRelease: makeHelmRelease(lockedNs),
  prometheusQuery: makePrometheusQuery(config.prometheus, regexRedactionRules),
  awsCli: makeAwsCli({ audit: config.audit }, regexRedactionRules),
  trivyScan: makeTrivyScan({ audit: config.audit }, regexRedactionRules),
  kubecostQuery: makeKubecostQuery(config.kubecost, regexRedactionRules, lockedNs),
  lokiQuery: makeLokiQuery(config.loki, regexRedactionRules, lockedNs),
  jaegerQuery: makeJaegerQuery(config.jaeger, regexRedactionRules),
  datadogQuery: makeDatadogQuery(config.datadog, regexRedactionRules),
  newRelicQuery: makeNewRelicQuery(config.newRelic, regexRedactionRules),
  cdkQuery: makeCdkQuery({ audit: config.audit }, regexRedactionRules),
};

export const enabledTools: ToolDefinition[] = (
  Object.keys(ALL_TOOLS) as (keyof HeimdallConfig['tools'])[]
)
  .filter((key) => config.tools[key])
  .map((key) => ALL_TOOLS[key]);

/**
 * Convert a Flue ToolDefinition's parameters to an MCP-compatible JSON Schema
 * input schema object.
 *
 * Valibot schemas (detected by their `kind === 'schema'` marker) are converted
 * via `@valibot/to-json-schema`. Raw JSON Schema objects (e.g. from MCP adapters
 * or other schema libraries) are passed through as-is. Falls back to a bare
 * `{ type: 'object' }` when neither conversion applies.
 */
export function parametersToInputSchema(parameters: unknown): {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
} {
  const isValibotSchema =
    typeof parameters === 'object' &&
    parameters !== null &&
    'kind' in parameters &&
    (parameters as { kind: unknown }).kind === 'schema';

  if (isValibotSchema) {
    try {
      const jsonSchema = toJsonSchema(
        parameters as v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
      ) as Record<string, unknown>;
      return {
        type: 'object',
        ...(jsonSchema.properties !== undefined && {
          properties: jsonSchema.properties as Record<string, unknown>,
        }),
        ...(Array.isArray(jsonSchema.required) && {
          required: jsonSchema.required as string[],
        }),
      };
    } catch {
      // Conversion failed — fall through to bare schema below.
    }
  }

  // parameters is a raw JSON Schema object (or something unrecognised) — use directly.
  const raw = (parameters ?? {}) as Record<string, unknown>;
  return {
    type: 'object',
    ...(raw.properties !== undefined && {
      properties: raw.properties as Record<string, unknown>,
    }),
    ...(Array.isArray(raw.required) && { required: raw.required as string[] }),
  };
}

export function createMcpServer(): Server {
  const server = new Server(
    { name: 'heimdall', version: '0.2.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Heimdall is a read-only Kubernetes SRE agent. All tools are safe to call — ' +
        'they only read cluster state and never mutate it.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: enabledTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: parametersToInputSchema(tool.parameters),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = enabledTools.find((t) => t.name === name);

    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
      };
    }

    try {
      // Validate args against the tool's valibot schema when possible.
      // Raw JSON Schema tools (no `kind`) skip validation and pass args directly.
      let validatedArgs: Record<string, unknown>;
      const isValibotParams =
        typeof tool.parameters === 'object' &&
        tool.parameters !== null &&
        'kind' in tool.parameters &&
        (tool.parameters as { kind: unknown }).kind === 'schema';

      if (isValibotParams) {
        const parseResult = v.safeParse(
          tool.parameters as v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
          args ?? {},
        );
        if (!parseResult.success) {
          const messages = parseResult.issues.map((i) => i.message).join('; ');
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Invalid arguments: ${messages}` }],
          };
        }
        validatedArgs = parseResult.output as Record<string, unknown>;
      } else {
        validatedArgs = (args ?? {}) as Record<string, unknown>;
      }

      const result = await (
        tool as ToolDefinition & {
          execute: (args: Record<string, unknown>) => Promise<string>;
        }
      ).execute(validatedArgs);

      return { content: [{ type: 'text' as const, text: result }] };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: err instanceof Error ? err.message : String(err),
          },
        ],
      };
    }
  });

  return server;
}

// Start the MCP server when this file is run directly (not when imported).
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
