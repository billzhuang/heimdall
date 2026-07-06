/**
 * Heimdall configuration loader.
 *
 * Reads `heimdall.config.yaml` from the working directory (or the path set in
 * `HEIMDALL_CONFIG`) and returns a validated config object.  Missing keys fall
 * back to safe defaults so the agent works out-of-the-box with zero config.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as yaml from 'js-yaml';
import * as v from 'valibot';

// v.nullish handles both `undefined` (missing key) and `null` (empty YAML block,
// e.g. `tools:` with no value), which js-yaml parses as null, not undefined.
const ToolsSchema = v.nullish(
  v.object({
    kubectl: v.nullish(v.boolean(), true),
    listContexts: v.nullish(v.boolean(), true),
    listNamespaces: v.nullish(v.boolean(), true),
    helmRelease: v.nullish(v.boolean(), true),
    prometheusQuery: v.nullish(v.boolean(), false),
    // Disabled by default: requires AWS CLI credentials in the environment.
    awsCli: v.nullish(v.boolean(), false),
    // Disabled by default: requires trivy binary on PATH.
    trivyScan: v.nullish(v.boolean(), false),
    // Disabled by default: requires a running Kubecost instance.
    kubecostQuery: v.nullish(v.boolean(), false),
    // Disabled by default: requires a running Grafana Loki instance.
    lokiQuery: v.nullish(v.boolean(), false),
    // Disabled by default: requires a running Jaeger or Grafana Tempo instance.
    jaegerQuery: v.nullish(v.boolean(), false),
    // Disabled by default: requires Datadog API key and app key.
    datadogQuery: v.nullish(v.boolean(), false),
    // Disabled by default: requires New Relic API key and account ID.
    newRelicQuery: v.nullish(v.boolean(), false),
    // Disabled by default: requires CDK CLI on PATH and AWS credentials.
    cdkQuery: v.nullish(v.boolean(), false),
  }),
  // `{}` is enough: valibot re-runs a nullish default through the wrapped object
  // schema, so each field's own inline default (above) applies. No need to
  // restate every key/value pair here — that would just be the same facts twice.
  {},
);

function makeUrlTimeoutSchema(defaultTimeoutMs = 10_000) {
  return v.nullish(v.object({
    url: v.nullish(v.string()),
    timeoutMs: v.nullish(v.number(), defaultTimeoutMs),
  }));
}

// Prometheus HTTP API config — optional, disabled by default.
// Base URL also readable from PROMETHEUS_URL env var.
const PrometheusSchema = makeUrlTimeoutSchema();

// Kubecost HTTP API config — optional, disabled by default.
// Base URL also readable from KUBECOST_URL env var.
const KubecostSchema = makeUrlTimeoutSchema();

// Jaeger / Grafana Tempo HTTP API config — optional, disabled by default.
// Point url at Jaeger Query (port 16686) or Tempo's Jaeger-compatible API.
// Also readable from JAEGER_URL env var.
const JaegerSchema = makeUrlTimeoutSchema();

// Grafana Loki HTTP API config — optional, disabled by default.
// Base URL also readable from LOKI_URL env var. Uses a 15 s timeout (log queries run longer).
const LokiSchema = makeUrlTimeoutSchema(15_000);

// Datadog API config — optional, disabled by default.
// Requires a Datadog account and API/App keys.
const DatadogSchema = v.nullish(
  v.object({
    // Datadog API key. Also readable from DD_API_KEY or DATADOG_API_KEY env var.
    apiKey: v.nullish(v.string()),
    // Datadog Application key. Also readable from DD_APP_KEY or DATADOG_APP_KEY env var.
    appKey: v.nullish(v.string()),
    // Datadog site, e.g. "datadoghq.com" (default), "datadoghq.eu", "us3.datadoghq.com".
    // Also readable from DD_SITE env var.
    site: v.nullish(v.string()),
    // Request timeout in milliseconds (default 15 000).
    timeoutMs: v.nullish(v.number(), 15_000),
  }),
);

// New Relic NerdGraph API config — optional, disabled by default.
// Requires a New Relic account, API key, and account ID.
const NewRelicSchema = v.nullish(
  v.object({
    // New Relic User API key. Also readable from NEW_RELIC_API_KEY env var.
    apiKey: v.nullish(v.string()),
    // New Relic account ID. Also readable from NEW_RELIC_ACCOUNT_ID env var.
    // Accept both string and number so bare YAML integers (accountId: 1234567) work.
    accountId: v.nullish(v.pipe(v.union([v.string(), v.number()]), v.transform(String))),
    // Request timeout in milliseconds (default 15 000).
    timeoutMs: v.nullish(v.number(), 15_000),
  }),
);

const AuditSchema = v.nullish(
  v.object({
    enabled: v.nullish(v.boolean(), false),
    // Omit `file` (or set it to null/empty) to write to stderr.
    file: v.nullish(v.string()),
  }),
  {},
);

// Configurable regex redaction rules — applied to all tool output before the model sees it.
const RedactionRuleSchema = v.object({
  name: v.string(),
  pattern: v.string(),
});

const RedactionSchema = v.nullish(
  v.object({
    enabled: v.nullish(v.boolean(), false),
    rules: v.nullish(v.array(RedactionRuleSchema), []),
  }),
  {},
);

// SLO definition — each entry configures one Service Level Objective and its
// Prometheus metric query. The metric should return the current error rate / non-compliance
// fraction (a value between 0 and 1) as an instant Prometheus vector result.
const SloEntrySchema = v.object({
  // Human-readable name for the SLO, e.g. "API availability".
  name: v.string(),
  // PromQL expression returning the current error rate/fraction (0–1).
  // Example: sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))
  metric: v.string(),
  // SLO target as a fraction, e.g. 0.999 for 99.9%.
  target: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  // Measurement window, e.g. "30d", "7d". Used for display and reporting.
  window: v.string(),
  // Error budget as a fraction, e.g. 0.001. Typically equals (1 − target).
  budget: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
});

// SLO list — empty by default. Populated via the `slos` key in heimdall.config.yaml.
const SlosSchema = v.nullish(v.array(SloEntrySchema), []);

// Event sink config — optional durable storage for watch-mode findings.
const EventSinkSchema = v.nullish(
  v.object({
    // Append each event digest as a JSONL line to this file.
    filePath: v.nullish(v.string()),
    // POST each event digest as JSON to this URL.
    webhookUrl: v.nullish(v.string()),
    // S3 bucket for event digest uploads (reserved; requires AWS CLI on PATH).
    s3Bucket: v.nullish(v.string()),
  }),
);

// Watch mode config — controls the proactive K8s Warning event monitor.
const WatchSchema = v.nullish(
  v.object({
    // Namespaces to watch. Omit (or empty) to watch all namespaces (-A).
    namespaces: v.nullish(v.array(v.string())),
    // Webhook URL to POST JSON finding lines to (e.g. a Slack incoming webhook).
    webhook: v.nullish(v.string()),
    // Only diagnose events whose Reason matches one of these strings.
    // Omit (or empty) to diagnose all Warning events.
    reasons: v.nullish(v.array(v.string())),
    // Cooldown window in seconds before re-diagnosing the same (object, reason).
    // Prevents LLM cost explosions and alert fatigue from repeated events.
    // Default: 300 (5 minutes). Set to 0 to disable cooldown.
    cooldownSeconds: v.nullish(v.number(), 300),
    // Maximum number of consecutive reconnect attempts before giving up.
    // Omit (or set to null) for unlimited retries.
    maxReconnectAttempts: v.nullish(v.number()),
    // Optional durable storage for post-mortem analysis of watch-mode findings.
    eventSink: EventSinkSchema,
  }),
);

// Namespace lockdown — restricts the agent to a single namespace enforced in code.
const NamespaceSchema = v.nullish(
  v.object({
    locked: v.nullish(v.pipe(v.string(), v.minLength(1))),
  }),
);

// Runbook integration — local markdown files injected into the system prompt.
const RunbookEntrySchema = v.object({
  path: v.string(),
  tags: v.nullish(v.array(v.string()), []),
});

// PagerDuty alert source — maps PD service names to K8s targets.
const AlertPagerDutySchema = v.nullish(
  v.object({
    enabled: v.nullish(v.boolean(), false),
    // Maps PD service.name → "namespace" or "namespace/deployment".
    serviceMap: v.nullish(v.record(v.string(), v.string()), {}),
  }),
  {},
);

const AlertSchema = v.nullish(
  v.object({
    pagerduty: AlertPagerDutySchema,
  }),
);

// RAG config — semantic retrieval over past task history.
const RagSchema = v.nullish(
  v.object({
    // Set to true to enable RAG context injection at agent startup.
    enabled: v.nullish(v.boolean(), false),
    // Number of past incidents to retrieve and inject (default 5).
    topK: v.nullish(v.number(), 5),
    // Minimum cosine similarity threshold (0–1). Entries below this score are
    // excluded. Default 0 (return all top-K regardless of score).
    minSimilarity: v.nullish(v.number(), 0),
  }),
  {},
);

// Learning config — controls real-task history logging for self-improvement.
const LearningSchema = v.nullish(
  v.object({
    // Set to false to disable task-history logging entirely. Defaults to true.
    enabled: v.nullish(v.boolean(), true),
    // Path for the task-history JSONL log. Defaults to scenarios/task-history.jsonl
    // relative to the Heimdall package root. Set to an absolute path to redirect.
    file: v.nullish(v.string()),
    // Path for the self-improve learning log (scenarios/learning-log.jsonl by default).
    // In container/lambda deployments where the local filesystem is ephemeral, set this
    // to a path on a mounted persistent volume, or use HEIMDALL_LEARNING_LOG env var.
    logFile: v.nullish(v.string()),
    // Path for the anomaly baseline JSONL store. Defaults to scenarios/baselines.jsonl.
    // Baselines accumulate recurring critical/warning findings across triage and watch runs,
    // so the agent can recognise known patterns without re-investigating from scratch.
    baselineFile: v.nullish(v.string()),
    // RAG-based semantic retrieval over task history (disabled by default).
    rag: RagSchema,
  }),
  {},
);

// Slack notification sink — post investigation findings to a Slack channel.
const SlackSchema = v.nullish(
  v.object({
    enabled: v.nullish(v.boolean(), false),
    // Incoming webhook URL. Also readable from SLACK_WEBHOOK_URL env var.
    webhookUrl: v.nullish(v.string()),
    // Optional channel override (e.g. '#sre-alerts'). The webhook's default channel is used when omitted.
    channel: v.nullish(v.string()),
    // Minimum severity that triggers a notification: 'info' | 'warning' | 'critical'.
    minSeverity: v.nullish(v.picklist(['info', 'warning', 'critical']), 'warning'),
    // Request timeout in milliseconds (default 10 000).
    timeoutMs: v.nullish(v.number(), 10_000),
  }),
  {},
);


// Schedule config — periodic automated triage sweeps.
const ScheduleTriageSchema = v.nullish(
  v.object({
    // Set to true to enable the triage schedule.
    enabled: v.nullish(v.boolean(), false),
    // Standard 5-field UTC cron expression, e.g. "0 */6 * * *" (every 6 h at :00).
    // Fields: minute hour day-of-month month day-of-week.
    cron: v.nullish(v.string(), '0 */6 * * *'),
    // Optional namespace scope (passed as -n to triage). Omit for default namespace.
    namespace: v.nullish(v.pipe(v.string(), v.minLength(1))),
    // Sweep all namespaces (-A). Overrides namespace when true.
    allNamespaces: v.nullish(v.boolean(), false),
  }),
  {},
);

const ScheduleSchema = v.nullish(
  v.object({
    triage: ScheduleTriageSchema,
  }),
);

// Infrastructure drift detection — disabled by default; compares each triage run against a stored checkpoint.
const DriftSchema = v.nullish(
  v.object({
    // Set to true to enable drift detection on every triage run.
    enabled: v.nullish(v.boolean(), false),
    // Path for the checkpoint JSONL file (alongside task-history.jsonl by default).
    checkpointFile: v.nullish(v.string()),
  }),
  {},
);

// Performance telemetry — disabled by default; auto-enabled by HEIMDALL_TELEMETRY_FILE env var.
const TelemetrySchema = v.nullish(
  v.object({
    enabled: v.nullish(v.boolean(), false),
    // File path for the JSON output blob. Omit to write to stderr.
    file: v.nullish(v.string()),
  }),
  {},
);

// OpenTelemetry export — push Heimdall metrics to an OTLP/HTTP endpoint.
// Standard env vars (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS,
// OTEL_METRIC_EXPORT_INTERVAL, OTEL_SERVICE_NAME) are also respected at runtime
// so this config block is optional if you set env vars directly.
const OtelSchema = v.nullish(
  v.object({
    // Set to true to enable periodic OTLP push (even if endpoint is set via env var).
    enabled: v.nullish(v.boolean(), false),
    // OTLP/HTTP endpoint base URL, e.g. "http://localhost:4318".
    // Also readable from OTEL_EXPORTER_OTLP_ENDPOINT.
    endpoint: v.nullish(v.string()),
    // HTTP headers for authentication, e.g. { Authorization: "Bearer token" }.
    // Also parsed from OTEL_EXPORTER_OTLP_HEADERS ("key=value,key2=value2" format).
    headers: v.nullish(v.record(v.string(), v.string()), {}),
    // Export interval in milliseconds (default 60000).
    // Also readable from OTEL_METRIC_EXPORT_INTERVAL.
    exportIntervalMs: v.nullish(v.number()),
    // OTEL service.name resource attribute (default "heimdall").
    // Also readable from OTEL_SERVICE_NAME.
    serviceName: v.nullish(v.string()),
  }),
  {},
);

// HTTP server config — used by `heimdall serve` mode.
const ServerSchema = v.nullish(
  v.object({
    // TCP port to listen on (default 3000). Override with HEIMDALL_PORT env var.
    port: v.nullish(v.number(), 3000),
    // Bind address (default '127.0.0.1' — loopback only). Override with HEIMDALL_HOST env var.
    host: v.nullish(v.string(), '127.0.0.1'),
    // Optional API key for Bearer token authentication. Override with HEIMDALL_API_KEY env var.
    // When unset, the server is unauthenticated (safe for loopback-only deployments).
    apiKey: v.nullish(v.string()),
  }),
  {},
);

const HeimdallConfigSchema = v.object({
  tools: ToolsSchema,
  audit: AuditSchema,
  watch: WatchSchema,
  // Redact Secret .data / .stringData values in kubectl output (code-enforced, default on).
  redactSecrets: v.nullish(v.boolean(), true),
  prometheus: PrometheusSchema,
  kubecost: KubecostSchema,
  loki: LokiSchema,
  jaeger: JaegerSchema,
  datadog: DatadogSchema,
  newRelic: NewRelicSchema,
  // User-configurable regex redaction rules (disabled by default).
  redaction: RedactionSchema,
  namespace: NamespaceSchema,
  // Local markdown runbooks loaded into system context at startup.
  runbooks: v.nullish(v.array(RunbookEntrySchema), []),
  // Slack notification sink (disabled by default).
  slack: SlackSchema,
  // Task-history learning log (enabled by default).
  learning: LearningSchema,
  // Alert source configuration (PagerDuty webhook parser, etc.).
  alert: AlertSchema,
  // Scheduled periodic operations (disabled by default).
  schedule: ScheduleSchema,
  // Service Level Objectives to evaluate against Prometheus (empty by default).
  slos: SlosSchema,
  // Infrastructure drift detection: compare each triage run against a stored cluster snapshot (disabled by default).
  drift: DriftSchema,
  // Performance telemetry: token usage, cache hit rate, tool-call latency (disabled by default).
  telemetry: TelemetrySchema,
  // OpenTelemetry push export to OTLP/HTTP endpoint (disabled by default).
  otel: OtelSchema,
  // HTTP server settings for `heimdall serve` mode (disabled by default; port 3000).
  server: ServerSchema,
});

export type HeimdallConfig = v.InferOutput<typeof HeimdallConfigSchema>;

// Canonical tool config keys mapped to the snake_case alias operators may use
// instead (matching the tool name the model sees, e.g. `list_contexts`).
// Typed against the schema so TypeScript enforces this map stays in sync when
// new tool keys are added to ToolsSchema — missing a key here is a compile
// error. KNOWN_TOOL_KEYS and SNAKE_CASE_ALIASES below are both derived from
// this single source so the two can never drift out of sync with each other.
const TOOL_KEY_TO_SNAKE_ALIAS: Record<keyof NonNullable<HeimdallConfig['tools']>, string> = {
  kubectl: 'kubectl',
  listContexts: 'list_contexts',
  listNamespaces: 'list_namespaces',
  helmRelease: 'helm_release',
  prometheusQuery: 'prometheus_query',
  awsCli: 'aws_cli',
  trivyScan: 'trivy_scan',
  kubecostQuery: 'kubecost_query',
  lokiQuery: 'loki_query',
  jaegerQuery: 'jaeger_query',
  datadogQuery: 'datadog_query',
  newRelicQuery: 'new_relic_query',
  cdkQuery: 'cdk_query',
};

const KNOWN_TOOL_KEYS = new Set(Object.keys(TOOL_KEY_TO_SNAKE_ALIAS));

// Accepted snake_case aliases → canonical camelCase key.
// Operators often copy the tool name the model sees (e.g. `list_contexts`)
// instead of the camelCase config key; accept both and convert silently.
const SNAKE_CASE_ALIASES: Record<string, keyof NonNullable<HeimdallConfig['tools']>> = Object.fromEntries(
  Object.entries(TOOL_KEY_TO_SNAKE_ALIAS)
    .filter(([camel, snake]) => camel !== snake)
    .map(([camel, snake]) => [snake, camel]),
) as Record<string, keyof NonNullable<HeimdallConfig['tools']>>;

/**
 * Normalise and validate the raw tools block before schema validation:
 * - Convert snake_case aliases → camelCase so `list_contexts: false` works correctly.
 * - Warn for unknown keys; pass them through so valibot can handle future additions.
 */
function normalizeToolsBlock(
  tools: unknown,
  filePath: string,
): Record<string, unknown> | undefined {
  if (tools === null || tools === undefined || typeof tools !== 'object' || Array.isArray(tools)) return undefined;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tools as Record<string, unknown>)) {
    const alias = SNAKE_CASE_ALIASES[key];
    if (alias) {
      normalized[alias] = value;
    } else if (KNOWN_TOOL_KEYS.has(key)) {
      normalized[key] = value;
    } else {
      const knownList = [...KNOWN_TOOL_KEYS, ...Object.keys(SNAKE_CASE_ALIASES)].join(', ');
      console.warn(`[heimdall] Config ${filePath}: unknown tools key "${key}". Known keys: ${knownList}`);
      normalized[key] = value; // pass through for forward-compat with future schema additions
    }
  }
  return normalized;
}

function resolveConfigPath(): string {
  const envPath = process.env.HEIMDALL_CONFIG;
  if (envPath) return resolve(envPath);
  return resolve(process.cwd(), 'heimdall.config.yaml');
}

/** Parse an empty document through the schema to get a fresh default object. */
function defaultConfig(): HeimdallConfig {
  return v.parse(HeimdallConfigSchema, {});
}

/** Parse raw YAML content into a validated HeimdallConfig. */
function parseYamlContent(yamlStr: string, source: string): HeimdallConfig {
  let raw: unknown;
  try {
    raw = yaml.load(yamlStr);
  } catch (err) {
    console.warn(`[heimdall] Could not parse YAML from ${source}:`, err);
    return defaultConfig();
  }

  // yaml.load returns a scalar (string, boolean, number) for degenerate input.
  if (raw !== null && raw !== undefined && typeof raw !== 'object') {
    console.warn(`[heimdall] Config from ${source} must be a YAML mapping, got ${typeof raw}`);
    return defaultConfig();
  }

  const rawObj = (raw ?? {}) as Record<string, unknown>;
  const tools = normalizeToolsBlock(rawObj['tools'], source);

  const result = v.safeParse(HeimdallConfigSchema, {
    ...rawObj,
    ...(tools !== undefined ? { tools } : {}),
  });
  if (!result.success) {
    console.warn(`[heimdall] Invalid config from ${source}:`, result.issues);
    return defaultConfig();
  }
  return result.output;
}

/**
 * Read a config file, returning its contents or null.
 * ENOENT is treated as "not configured" and returns null silently.
 * Any other error (e.g. EISDIR, EPERM) logs a warning and also returns null.
 *
 * Using a single try/catch avoids the TOCTOU race between an existsSync check
 * and the subsequent readFileSync call.
 */
export function tryReadConfigFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[heimdall] Could not read config file ${path}:`, err);
    }
    return null;
  }
}

/**
 * Load and validate the Heimdall config.
 *
 * Resolution order:
 *  1. Explicit `configPath` argument (used in tests and CLI overrides).
 *  2. `HEIMDALL_CONFIG_YAML` env var — raw YAML string; intended for runtimes
 *     without a local filesystem such as Cloudflare Workers.
 *  3. `HEIMDALL_CONFIG` env var — path to a YAML file.
 *  4. `heimdall.config.yaml` in the current working directory.
 */
export function loadConfig(configPath?: string): HeimdallConfig {
  if (configPath) {
    const yamlStr = tryReadConfigFile(configPath);
    if (yamlStr === null) return defaultConfig();
    return parseYamlContent(yamlStr, configPath);
  }

  // Inline YAML via env var — the only option on runtimes without node:fs.
  const inlineYaml = process.env.HEIMDALL_CONFIG_YAML;
  if (inlineYaml) {
    return parseYamlContent(inlineYaml, '<HEIMDALL_CONFIG_YAML>');
  }

  const filePath = resolveConfigPath();
  const yamlStr = tryReadConfigFile(filePath);
  if (yamlStr === null) return defaultConfig();
  return parseYamlContent(yamlStr, filePath);
}
