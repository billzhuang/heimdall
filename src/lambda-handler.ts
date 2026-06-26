/**
 * AWS Lambda handler for Heimdall.
 *
 * Adapts the Hono HTTP app (createServeApp) for AWS Lambda using Hono's
 * official aws-lambda adapter. Supports API Gateway HTTP API (v2), Lambda
 * Function URLs, and ALB events.
 *
 * Endpoints (same as serve mode):
 *   POST /api/diagnose      — one-shot AI K8s diagnosis
 *   GET  /api/health        — liveness probe (always public, no auth required)
 *   GET  /api/openapi.json  — OpenAPI 3.1 spec
 *   GET  /metrics           — Prometheus exposition format
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY      — required: Anthropic API key
 *   HEIMDALL_API_KEY       — optional: enable Bearer token auth (all routes except /api/health)
 *   HEIMDALL_MODEL         — optional: override model in provider/model format
 *   HEIMDALL_CONFIG        — optional: path to heimdall.config.yaml packaged in a Lambda layer
 *   HEIMDALL_CONFIG_YAML   — optional: raw YAML config content (alternative to a file path)
 *   OTEL_SERVICE_NAME      — optional: service name label in Prometheus metrics
 *   KUBECONFIG             — optional: kubeconfig path (e.g. /tmp/kubeconfig injected at runtime)
 *
 * Limitations vs. EKS pod deployment:
 *   - 15-minute hard timeout (Lambda hard limit)
 *   - watch / schedule / session / mcp modes require a persistent process — not supported here
 *   - Private EKS API server access requires VPC placement
 *   - No EKS Pod OIDC / IRSA; use the Lambda execution role for AWS credentials instead
 *
 * See deploy.md §"Option 2: AWS Lambda" for the full deployment sketch.
 */
import { handle } from 'hono/aws-lambda';
import { createServeApp, runAgentDiagnose } from './serve-mode.ts';
import { resolveModel } from './lib/model.ts';
import { loadConfig } from './lib/config.ts';

/**
 * Build a Lambda-compatible handler backed by the given agent function.
 *
 * Follows the same dependency-injection pattern as createServeApp so tests
 * can pass a mock agent without spawning a real subprocess.
 *
 * The returned handler is valid for:
 *   - AWS Lambda Function URLs
 *   - API Gateway HTTP API (payload format 2.0)
 *   - Application Load Balancer
 */
export function createLambdaHandler(
  agentFn: (prompt: string, model: string) => Promise<string> = runAgentDiagnose,
): ReturnType<typeof handle> {
  const config = loadConfig();

  const rawApiKey = process.env['HEIMDALL_API_KEY'] ?? config.server?.apiKey;
  const apiKey = rawApiKey && rawApiKey.trim() ? rawApiKey.trim() : undefined;

  const modelEnv = process.env['HEIMDALL_MODEL'];
  let defaultModel: string | undefined;
  try {
    defaultModel = resolveModel(modelEnv);
  } catch {
    // Treat an invalid / absent HEIMDALL_MODEL as unset; createServeApp falls
    // back to DEFAULT_MODEL through the model resolution chain.
    defaultModel = undefined;
  }

  const metricsServiceName =
    config.otel?.serviceName?.trim() ||
    process.env['OTEL_SERVICE_NAME']?.trim() ||
    undefined;

  const app = createServeApp(agentFn, defaultModel, apiKey, metricsServiceName);
  return handle(app);
}

/**
 * Default export — the Lambda handler for `module.handler` registration.
 * Initialized once at cold-start and reused across warm invocations.
 */
export const handler = createLambdaHandler();
