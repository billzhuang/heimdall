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
 *   GET  /metrics          — Prometheus exposition format (public, no auth)
 *
 * Usage:
 *   npm run serve
 *   heimdall serve [--port <n>] [--host <addr>] [--model <provider/model>]
 *
 * Configuration (heimdall.config.yaml):
 *   server:
 *     port: 3000         # default
 *     host: '127.0.0.1'  # default
 *
 * Environment overrides:
 *   HEIMDALL_PORT  — listen port
 *   HEIMDALL_HOST  — bind address
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.ts';
import type { OneShotFinding } from './lib/format-output.ts';
import { resolveModel } from './lib/model.ts';
import { resolveApiKey, resolveMetricsServiceName } from './lib/server-config.ts';
import { getTelemetrySnapshot, formatPrometheusMetrics } from './lib/telemetry.ts';
import { getMessage } from './lib/error-utils.ts';
import { resolveBinPath } from './lib/bin-path.ts';
import { isMainModule, parseFlagValue } from './lib/cli-args.ts';
import { spawnAndCollect } from './lib/spawn-collect.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DIAGNOSE_TIMEOUT_MS = 300_000; // 5 minutes

/** Parse a port string; returns the port number if it is an integer in [1, 65535], else null. */
export function parsePortValue(raw: string): number | null {
  const port = parseInt(raw, 10);
  return isNaN(port) || port < 1 || port > 65535 ? null : port;
}

/**
 * Parse a port value sourced from `label` (a CLI flag or env var name).
 * Returns the port, or the exact "Error: ..." message the CLI prints on failure —
 * shared by the `--port`, `--port=`, and `HEIMDALL_PORT` sources so the three
 * don't drift out of sync.
 */
export function parsePortArg(raw: string, label: string): { port: number } | { errorMessage: string } {
  const port = parsePortValue(raw);
  return port === null
    ? { errorMessage: `Error: ${label} must be an integer between 1 and 65535, got "${raw}"\n` }
    : { port };
}

/**
 * Spawn `heimdall -p <prompt> --json` and capture the structured JSON output.
 * Returns the raw JSON string emitted by format-json.ts.
 *
 * Runs the child as a process group leader (detached) so a timeout's SIGTERM
 * reaches all grandchildren (Flue agent, kubectl, etc.), not just the shell
 * wrapper. `timeoutMs` defaults to DIAGNOSE_TIMEOUT_MS; overridable for tests.
 */
export async function runAgentDiagnose(
  prompt: string,
  model: string,
  timeoutMs = DIAGNOSE_TIMEOUT_MS,
): Promise<string> {
  const binPath = resolveBinPath(__dirname);
  const env = { ...process.env, HEIMDALL_MODEL: model };
  return spawnAndCollect(binPath, ['-p', prompt, '--json'], {
    env,
    timeoutMs,
    detached: true,
    onTimeout: () => new Error(`agent timed out after ${timeoutMs / 1000}s`),
    onExit: (code, signal, stdout, stderr) => {
      if (code === 0) return null;
      if (signal !== null) return new Error(`heimdall agent killed by signal ${signal}`);
      return new Error(`heimdall agent exited with code ${code}${stderr ? `: ${stderr}` : ''}`);
    },
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
 * @param agentFn - Injectable agent runner; defaults to runAgentDiagnose.
 * @param serveDefaultModel - Model to use when the request omits "model".
 *   Must be provided when --model is passed at CLI startup since DEFAULT_MODEL
 *   is captured at module-load time and process.env mutations have no effect.
 * @param apiKey - Optional Bearer token. When provided all endpoints except
 *   GET /api/health require an `Authorization: Bearer <apiKey>` header. */
export function createServeApp(
  agentFn: (prompt: string, model: string) => Promise<string> = runAgentDiagnose,
  serveDefaultModel?: string,
  apiKey?: string | null,
  metricsServiceName?: string,
): Hono {
  const app = new Hono();

  // Auth middleware — active only when an API key is configured.
  // GET /api/health is always public so Kubernetes liveness probes work without credentials.
  // bearerAuth() provides timing-safe comparison and RFC 6750 WWW-Authenticate headers.
  if (apiKey) {
    const unauthorizedJson = { error: 'Unauthorized' };
    const auth = bearerAuth({
      token: apiKey,
      noAuthenticationHeaderMessage: unauthorizedJson,
      invalidAuthenticationHeaderMessage: unauthorizedJson,
      invalidTokenMessage: unauthorizedJson,
    });
    app.use('/api/openapi.json', auth);
    app.use('/api/diagnose', auth);
  }

  app.get('/api/health', (c) =>
    c.json({ status: 'ok', service: 'heimdall' }),
  );

  app.get('/api/openapi.json', (c) => c.json(OPENAPI_SPEC));

  // Prometheus metrics endpoint — always public (no auth) so scrapers work without credentials.
  app.get('/metrics', (c) => {
    const snapshot = getTelemetrySnapshot();
    const body = formatPrometheusMetrics(snapshot, metricsServiceName);
    return c.text(body, 200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    });
  });

  app.post('/api/diagnose', async (c) => {
    let body: Record<string, unknown>;
    try {
      const parsed = await c.req.json<unknown>();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return c.json({ error: 'Invalid JSON body: expected an object' }, 400);
      }
      body = parsed as Record<string, unknown>;
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
      model = resolveModel(modelOverride ?? serveDefaultModel);
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
      return c.json({ error: `Agent error: ${getMessage(err)}` }, 500);
    }
  });

  return app;
}

/** Resolve a port arg via `parsePortArg`, printing the error and exiting(1) on failure. */
function resolvePortArgOrExit(raw: string, label: string): number {
  const result = parsePortArg(raw, label);
  if ('errorMessage' in result) {
    process.stderr.write(result.errorMessage);
    process.exit(1);
  }
  return result.port;
}

const SERVE_HELP_TEXT = `Usage: heimdall serve [--port <n>] [--host <addr>] [--model <provider/model>]

Start an HTTP server exposing Heimdall's AI diagnostic capability as a REST API.

Options:
  --port <n>               TCP port to listen on (default: 3000; env: HEIMDALL_PORT)
  --host <addr>            Bind address (default: 127.0.0.1; env: HEIMDALL_HOST)
  --model <provider/model> Override LLM model (env: HEIMDALL_MODEL)
  -h, --help               Show this help message

Endpoints:
  POST /api/diagnose       { prompt, namespace?, model? } → OneShotFinding
  GET  /api/health         Liveness probe → { status, service }
  GET  /api/openapi.json   OpenAPI 3.1 spec
  GET  /metrics            Prometheus metrics (public)

Examples:
  heimdall serve
  heimdall serve --port 8080
  HEIMDALL_PORT=8080 heimdall serve
`;

export interface ServeCliArgs {
  port?: number;
  host?: string;
  model?: string;
}

/**
 * Parse `heimdall serve` CLI flags. Exits the process directly for --help,
 * a missing/invalid --port value, and unknown options, matching this mode's
 * historical behavior.
 */
export function parseServeArgv(argv: string[]): ServeCliArgs {
  let portArg: number | undefined;
  let hostArg: string | undefined;
  let modelArg: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' || arg.startsWith('--port=')) {
      const { value: raw, nextIndex } = parseFlagValue(argv, i, '--port');
      i = nextIndex;
      if (!raw) {
        process.stderr.write('Error: --port requires a value\n');
        process.exit(1);
        return { port: portArg, host: hostArg, model: modelArg };
      }
      portArg = resolvePortArgOrExit(raw, '--port');
    } else if (arg === '--host' || arg.startsWith('--host=')) {
      ({ value: hostArg, nextIndex: i } = parseFlagValue(argv, i, '--host'));
    } else if (arg === '--model' || arg.startsWith('--model=')) {
      ({ value: modelArg, nextIndex: i } = parseFlagValue(argv, i, '--model'));
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(SERVE_HELP_TEXT);
      process.exit(0);
    } else {
      process.stderr.write(`Error: unknown option: ${arg}\n`);
      process.exit(1);
    }
  }

  return { port: portArg, host: hostArg, model: modelArg };
}

// --- CLI entrypoint — parse args and start server when run directly ----------
if (isMainModule(import.meta.url)) {
  const { port: portArg, host: hostArg, model: modelArg } = parseServeArgv(process.argv.slice(2));

  const config = loadConfig();
  const rawEnvPort = process.env['HEIMDALL_PORT'];
  const envPort = rawEnvPort ? resolvePortArgOrExit(rawEnvPort, 'HEIMDALL_PORT') : undefined;
  const port = portArg ?? envPort ?? config.server?.port ?? 3000;
  const host =
    hostArg ??
    process.env['HEIMDALL_HOST'] ??
    config.server?.host ??
    '127.0.0.1';
  const apiKey = resolveApiKey(process.env['HEIMDALL_API_KEY'], config.server?.apiKey);
  const metricsServiceName = resolveMetricsServiceName(config.otel?.serviceName, process.env['OTEL_SERVICE_NAME']);
  const app = createServeApp(runAgentDiagnose, modelArg, apiKey, metricsServiceName);

  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    process.stderr.write(
      `[heimdall-serve] Listening on http://${info.address}:${info.port}\n`,
    );
    if (apiKey) {
      process.stderr.write('[heimdall-serve] Authentication: Bearer token required (HEIMDALL_API_KEY)\n');
    } else {
      process.stderr.write('[heimdall-serve] Authentication: none (set HEIMDALL_API_KEY to enable)\n');
    }
    const base = `http://${info.address}:${info.port}`;
    process.stderr.write(
      `[heimdall-serve] Endpoints:\n` +
      `  POST ${base}/api/diagnose\n` +
      `  GET  ${base}/api/health\n` +
      `  GET  ${base}/api/openapi.json\n` +
      `  GET  ${base}/metrics\n`,
    );
  });
}
