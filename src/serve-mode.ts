/**
 * Heimdall HTTP serve mode.
 *
 * Starts a Hono HTTP server that exposes Heimdall's AI diagnostic capability
 * as a REST API, enabling programmatic integration with CI/CD pipelines,
 * internal dashboards, and PagerDuty / OpsGenie webhooks.
 *
 * Endpoints:
 *   POST /api/diagnose     — run an agent investigation; returns OneShotFinding JSON
 *   GET  /api/health       — liveness probe
 *   GET  /api/openapi.json — OpenAPI 3.1 spec
 *
 * Usage:
 *   npm run serve
 *   heimdall serve [--port <n>] [--host <addr>] [--model <provider/model>]
 *
 * Configuration (heimdall.config.yaml):
 *   server:
 *     port: 3000         # default
 *     host: '0.0.0.0'   # default
 *
 * Environment overrides:
 *   HEIMDALL_PORT  — listen port
 *   HEIMDALL_HOST  — bind address
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.ts';
import type { OneShotFinding } from './lib/format-output.ts';
import { resolveModel } from './lib/model.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DIAGNOSE_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Spawn `heimdall -p <prompt> --json` and capture the structured JSON output.
 * Returns the raw JSON string emitted by format-json.ts.
 */
export async function runAgentDiagnose(prompt: string, model: string): Promise<string> {
  const binPath = resolve(__dirname, '..', 'bin', 'heimdall');
  return new Promise((resolveP, rejectP) => {
    let stdout = '';
    let settled = false;

    const env = { ...process.env, HEIMDALL_MODEL: model };
    const child = spawn(binPath, ['-p', prompt, '--json'], {
      // stderr is inherited so the parent never blocks on an unread pipe buffer.
      stdio: ['ignore', 'pipe', 'inherit'],
      env,
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        rejectP(new Error('agent timed out after 5 minutes'));
      }
    }, DIAGNOSE_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });

    child.on('close', (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolveP(stdout);
      } else if (signal !== null) {
        rejectP(new Error(`heimdall agent killed by signal ${signal}`));
      } else {
        rejectP(new Error(`heimdall agent exited with code ${code}`));
      }
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        rejectP(err);
      }
    });
  });
}

const OPENAPI_SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'Heimdall SRE API',
    version: '0.2.0',
    description:
      'Read-only AI-powered Kubernetes diagnostic REST API. ' +
      'All operations are advisory only — Heimdall never mutates cluster state.',
  },
  paths: {
    '/api/health': {
      get: {
        operationId: 'health',
        summary: 'Liveness probe',
        responses: {
          '200': {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    service: { type: 'string', example: 'heimdall' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/diagnose': {
      post: {
        operationId: 'diagnose',
        summary: 'Run a Kubernetes diagnostic investigation',
        description:
          'Accepts a natural-language prompt and optional namespace scope. ' +
          'Invokes the Heimdall agent with its full suite of read-only kubectl, Helm, ' +
          'and observability tools, and returns a structured diagnosis.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['prompt'],
                properties: {
                  prompt: {
                    type: 'string',
                    description: 'Natural-language diagnosis question',
                    example: 'Why is my api pod crash-looping in prod?',
                  },
                  namespace: {
                    type: 'string',
                    description: 'Optional namespace to scope the investigation',
                    example: 'prod',
                  },
                  model: {
                    type: 'string',
                    description: 'Override LLM model in provider/model format',
                    example: 'anthropic/claude-opus-4-8',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Structured diagnosis result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    summary: { type: 'string', description: 'Reasoning summary bullets' },
                    answer: { type: 'string', description: 'Full agent answer (Markdown)' },
                    severity: {
                      type: 'string',
                      enum: ['critical', 'warning', 'info'],
                      description: 'Heuristic severity inferred from the answer',
                    },
                    suggestedCommands: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'kubectl commands extracted from the answer (advisory only)',
                    },
                    model: { type: 'string', description: 'Provider/model used' },
                    causalChain: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Ordered reasoning steps leading to the root cause',
                    },
                    evidence: {
                      type: 'object',
                      additionalProperties: { type: 'string' },
                      description: 'Map of finding to supporting kubectl/Prometheus output',
                    },
                    validityScore: {
                      type: 'number',
                      minimum: 0,
                      maximum: 1,
                      description: 'Root-cause confidence score (0–1)',
                    },
                    remediationSteps: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Recommended remediation actions',
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid request body' },
          '500': { description: 'Agent invocation error' },
        },
      },
    },
  },
} as const;

/** Create and return the configured Hono app (exported for testing).
 * @param agentFn - Injectable agent runner; defaults to runAgentDiagnose. */
export function createServeApp(
  agentFn: (prompt: string, model: string) => Promise<string> = runAgentDiagnose,
): Hono {
  const app = new Hono();

  app.get('/api/health', (c) =>
    c.json({ status: 'ok', service: 'heimdall' }),
  );

  app.get('/api/openapi.json', (c) => c.json(OPENAPI_SPEC));

  app.post('/api/diagnose', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const prompt = body['prompt'];
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return c.json(
        { error: '"prompt" is required and must be a non-empty string' },
        400,
      );
    }

    const namespace =
      typeof body['namespace'] === 'string' ? body['namespace'] : undefined;
    const modelOverride =
      typeof body['model'] === 'string' ? body['model'] : undefined;

    let model: string;
    try {
      model = resolveModel(modelOverride);
    } catch {
      return c.json(
        {
          error:
            'Invalid model specifier — use "provider/model" format, ' +
            'e.g. "anthropic/claude-opus-4-8"',
        },
        400,
      );
    }

    const fullPrompt = namespace
      ? `${prompt.trim()}\n\nScope: namespace "${namespace}"`
      : prompt.trim();

    try {
      const raw = await agentFn(fullPrompt, model);
      const trimmed = raw.trim();
      if (!trimmed) {
        return c.json({ error: 'Agent produced no output' }, 500);
      }
      const finding = JSON.parse(trimmed) as OneShotFinding;
      return c.json(finding);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Agent error: ${message}` }, 500);
    }
  });

  return app;
}

// --- CLI entrypoint — parse args and start server when run directly ----------
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const cliArgs = process.argv.slice(2);
  let portArg: number | undefined;
  let hostArg: string | undefined;
  let modelArg: string | undefined;

  for (let i = 0; i < cliArgs.length; i++) {
    const arg = cliArgs[i];
    if (arg === '--port') {
      const raw = cliArgs[++i];
      if (!raw) { process.stderr.write('Error: --port requires a value\n'); process.exit(1); }
      portArg = parseInt(raw, 10);
      if (isNaN(portArg) || portArg < 1 || portArg > 65535) {
        process.stderr.write(`Error: --port must be an integer between 1 and 65535, got "${raw}"\n`);
        process.exit(1);
      }
    } else if (arg.startsWith('--port=')) {
      const raw = arg.slice('--port='.length);
      portArg = parseInt(raw, 10);
      if (isNaN(portArg) || portArg < 1 || portArg > 65535) {
        process.stderr.write(`Error: --port must be an integer between 1 and 65535, got "${raw}"\n`);
        process.exit(1);
      }
    } else if (arg === '--host') {
      hostArg = cliArgs[++i];
    } else if (arg.startsWith('--host=')) {
      hostArg = arg.slice('--host='.length);
    } else if (arg === '--model') {
      modelArg = cliArgs[++i];
    } else if (arg.startsWith('--model=')) {
      modelArg = arg.slice('--model='.length);
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(`Usage: heimdall serve [--port <n>] [--host <addr>] [--model <provider/model>]

Start an HTTP server exposing Heimdall's AI diagnostic capability as a REST API.

Options:
  --port <n>               TCP port to listen on (default: 3000; env: HEIMDALL_PORT)
  --host <addr>            Bind address (default: 0.0.0.0; env: HEIMDALL_HOST)
  --model <provider/model> Override LLM model (env: HEIMDALL_MODEL)
  -h, --help               Show this help message

Endpoints:
  POST /api/diagnose       { prompt, namespace?, model? } → OneShotFinding
  GET  /api/health         Liveness probe → { status, service }
  GET  /api/openapi.json   OpenAPI 3.1 spec

Examples:
  heimdall serve
  heimdall serve --port 8080
  HEIMDALL_PORT=8080 heimdall serve
`);
      process.exit(0);
    } else {
      process.stderr.write(`Error: unknown option: ${arg}\n`);
      process.exit(1);
    }
  }

  if (modelArg) process.env['HEIMDALL_MODEL'] = modelArg;

  const config = loadConfig();
  const envPort = process.env['HEIMDALL_PORT']
    ? parseInt(process.env['HEIMDALL_PORT'], 10)
    : undefined;
  if (envPort !== undefined && (isNaN(envPort) || envPort < 1 || envPort > 65535)) {
    process.stderr.write(
      `Error: HEIMDALL_PORT must be an integer between 1 and 65535, got "${process.env['HEIMDALL_PORT']}"\n`,
    );
    process.exit(1);
  }
  const port = portArg ?? envPort ?? config.server?.port ?? 3000;
  const host =
    hostArg ??
    process.env['HEIMDALL_HOST'] ??
    config.server?.host ??
    '0.0.0.0';

  const app = createServeApp();

  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    process.stderr.write(
      `[heimdall-serve] Listening on http://${info.address}:${info.port}\n`,
    );
    process.stderr.write('[heimdall-serve] Endpoints:\n');
    process.stderr.write(
      `  POST http://${info.address}:${info.port}/api/diagnose\n`,
    );
    process.stderr.write(
      `  GET  http://${info.address}:${info.port}/api/health\n`,
    );
    process.stderr.write(
      `  GET  http://${info.address}:${info.port}/api/openapi.json\n`,
    );
  });
}
