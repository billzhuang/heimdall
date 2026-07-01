/**
 * AWS Bedrock AgentCore Runtime handler for Heimdall.
 *
 * Implements the AgentCore container protocol:
 *   GET  /ping         — liveness / health check (always returns 200 OK)
 *   POST /invocations  — run an AI K8s diagnosis; accepts AgentCore payload
 *
 * AgentCore invocation request body:
 *   { inputText: string, sessionId?: string, sessionAttributes?: Record<string, string> }
 *
 * AgentCore invocation response body:
 *   { outputText: string, sessionId?: string, sessionAttributes?: Record<string, string> }
 *
 * The structured OneShotFinding is embedded as JSON in
 * sessionAttributes["heimdall_finding"] for clients that want the full result.
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY    — required: Anthropic API key
 *   HEIMDALL_MODEL       — optional: override model in provider/model format
 *   HEIMDALL_CONFIG      — optional: path to heimdall.config.yaml
 *   HEIMDALL_CONFIG_YAML — optional: raw YAML config content
 *   AGENTCORE_PORT       — optional: HTTP listen port (default: 8080)
 *   KUBECONFIG           — optional: kubeconfig path
 *   OTEL_SERVICE_NAME    — optional: service name label in Prometheus metrics
 *
 * Limitations vs. EKS pod deployment:
 *   - No watch / schedule / session / mcp modes (requires persistent process)
 *   - Private EKS API server access requires VPC attachment on the AgentCore runtime
 *   - No EKS Pod OIDC / IRSA; use the AgentCore execution role for AWS credentials
 *
 * See deploy.md §"Option 6: AWS Bedrock AgentCore Runtime" for the full deployment guide.
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { fileURLToPath } from 'node:url';
import { runAgentDiagnose } from './serve-mode.ts';
import { resolveModel, resolveModelOrUndefined } from './lib/model.ts';
import { loadConfig } from './lib/config.ts';
import type { OneShotFinding } from './lib/format-output.ts';
import { getMessage } from './lib/error-utils.ts';

const AGENTCORE_PORT_DEFAULT = 8080;

/** AgentCore invocation request body */
interface AgentCoreRequest {
  inputText: string;
  sessionId?: string;
  sessionAttributes?: Record<string, string>;
}

/** AgentCore invocation response body */
interface AgentCoreResponse {
  outputText: string;
  sessionId?: string;
  sessionAttributes?: Record<string, string>;
}

type ParsedAgentCoreRequest =
  | { ok: true; body: AgentCoreRequest }
  | { ok: false; error: string };

/** Validate and normalize a parsed JSON body into an AgentCoreRequest. Pure — no I/O. */
export function parseAgentCoreRequestBody(parsed: unknown): ParsedAgentCoreRequest {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Invalid JSON body: expected an object' };
  }
  const raw = parsed as Record<string, unknown>;
  if (typeof raw['inputText'] !== 'string' || !(raw['inputText'] as string).trim()) {
    return { ok: false, error: '"inputText" is required and must be a non-empty string' };
  }
  return {
    ok: true,
    body: {
      inputText: (raw['inputText'] as string).trim(),
      sessionId: typeof raw['sessionId'] === 'string' ? raw['sessionId'] : undefined,
      sessionAttributes:
        raw['sessionAttributes'] &&
        typeof raw['sessionAttributes'] === 'object' &&
        !Array.isArray(raw['sessionAttributes'])
          ? (raw['sessionAttributes'] as Record<string, string>)
          : undefined,
    },
  };
}

/**
 * Build the AgentCore invocation response from a completed diagnosis. Pure — no I/O.
 *
 * `finding` comes from `JSON.parse`-ing untrusted agent subprocess output, so it may
 * be `null` (e.g. the agent emits the literal `"null"`) even though the call site
 * casts it to `OneShotFinding` — guard against that instead of trusting the cast.
 */
export function buildAgentCoreResponse(
  finding: OneShotFinding | null | undefined,
  trimmed: string,
  body: AgentCoreRequest,
): AgentCoreResponse {
  const safeFinding: Partial<OneShotFinding> =
    finding != null && typeof finding === 'object' ? finding : {};
  return {
    outputText: safeFinding.answer ?? trimmed,
    sessionId: body.sessionId,
    sessionAttributes: {
      ...(body.sessionAttributes ?? {}),
      heimdall_finding: JSON.stringify(finding),
      heimdall_severity: safeFinding.severity ?? 'info',
      heimdall_validity_score: String(safeFinding.validityScore ?? ''),
    },
  };
}

/**
 * Create the AgentCore Hono app.
 *
 * agentFn is injectable for testing; defaults to the real subprocess runner.
 * defaultModel is pre-resolved and passed through to every invocation.
 */
export function createAgentCoreApp(
  agentFn: (prompt: string, model: string) => Promise<string> = runAgentDiagnose,
  defaultModel?: string,
): Hono {
  const app = new Hono();

  // AgentCore uses GET /ping for liveness checks (same contract as SageMaker).
  app.get('/ping', (c) => c.text('OK', 200));

  app.post('/invocations', async (c) => {
    let parsed: unknown;
    try {
      parsed = await c.req.json<unknown>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const result = parseAgentCoreRequestBody(parsed);
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }
    const body = result.body;

    const model = resolveModelOrUndefined(defaultModel) ?? resolveModel(undefined);

    try {
      const raw = await agentFn(body.inputText, model);
      const trimmed = raw.trim();
      if (!trimmed) {
        return c.json({ error: 'Agent produced no output' }, 500);
      }
      const finding = JSON.parse(trimmed) as OneShotFinding;
      return c.json(buildAgentCoreResponse(finding, trimmed, body));
    } catch (err) {
      return c.json({ error: `Agent error: ${getMessage(err)}` }, 500);
    }
  });

  return app;
}

// --- CLI entrypoint — start HTTP server when run directly --------------------
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = loadConfig();

  const defaultModel = resolveModelOrUndefined(process.env['HEIMDALL_MODEL']);

  const envPort = process.env['AGENTCORE_PORT']
    ? parseInt(process.env['AGENTCORE_PORT'], 10)
    : undefined;
  const port = envPort ?? AGENTCORE_PORT_DEFAULT;

  const app = createAgentCoreApp(runAgentDiagnose, defaultModel);

  serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
    process.stderr.write(
      `[heimdall-agentcore] Listening on http://0.0.0.0:${info.port}\n`,
    );
    process.stderr.write('[heimdall-agentcore] Endpoints:\n');
    process.stderr.write(`  GET  http://0.0.0.0:${info.port}/ping\n`);
    process.stderr.write(`  POST http://0.0.0.0:${info.port}/invocations\n`);
    if (!config.server?.apiKey) {
      process.stderr.write('[heimdall-agentcore] Auth: IAM-based (AgentCore control plane)\n');
    }
  });
}
