/**
 * Heimdall configuration loader.
 *
 * Reads `heimdall.config.yaml` from the working directory (or the path set in
 * `HEIMDALL_CONFIG`) and returns a validated config object.  Missing keys fall
 * back to safe defaults so the agent works out-of-the-box with zero config.
 */
import { existsSync, readFileSync } from 'node:fs';
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
  { kubectl: true, listContexts: true, listNamespaces: true, helmRelease: true, prometheusQuery: false, awsCli: false, trivyScan: false, kubecostQuery: false, lokiQuery: false, jaegerQuery: false, datadogQuery: false, newRelicQuery: false, cdkQuery: false },
);

// Prometheus HTTP API config — optional, disabled by default.
const PrometheusSchema = v.nullish(
  v.object({
    // Base URL for the Prometheus HTTP API. Also readable from PROMETHEUS_URL env var.
    url: v.nullish(v.string()),
    // Request timeout in milliseconds (default 10 000).
    timeoutMs: v.nullish(v.number(), 10_000),
  }),
);

// Kubecost HTTP API config — optional, disabled by default.
const KubecostSchema = v.nullish(
  v.object({
    // Base URL for the Kubecost HTTP API. Also readable from KUBECOST_URL env var.
    url: v.nullish(v.string()),
    // Request timeout in milliseconds (default 10 000).
    timeoutMs: v.nullish(v.number(), 10_000),
  }),
);

// Jaeger / Grafana Tempo HTTP API config — optional, disabled by default.
// Point url at Jaeger Query (port 16686) or Tempo's Jaeger-compatible API.
// Also readable from JAEGER_URL env var.
const JaegerSchema = v.nullish(
  v.object({
    // Base URL for the Jaeger HTTP API. Also readable from JAEGER_URL env var.
    url: v.nullish(v.string()),
    // Request timeout in milliseconds (default 10 000).
    timeoutMs: v.nullish(v.number(), 10_000),
  }),
);

// Grafana Loki HTTP API config — optional, disabled by default.
const LokiSchema = v.nullish(
  v.object({
    // Base URL for the Loki HTTP API. Also readable from LOKI_URL env var.
    url: v.nullish(v.string()),
    // Request timeout in milliseconds (default 15 000).
    timeoutMs: v.nullish(v.number(), 15_000),
  }),
);

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
  { enabled: false },
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
  { enabled: false, rules: [] },
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
    locked: v.nullish(v.string()),
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
  { enabled: false, serviceMap: {} },
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
  { enabled: false, topK: 5, minSimilarity: 0 },
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
    // RAG-based semantic retrieval over task history (disabled by default).
    rag: RagSchema,
  }),
  { enabled: true },
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
  { enabled: false },
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
    namespace: v.nullish(v.string()),
    // Sweep all namespaces (-A). Overrides namespace when true.
    allNamespaces: v.nullish(v.boolean(), false),
  }),
  { enabled: false, cron: '0 */6 * * *', allNamespaces: false },
);

const ScheduleSchema = v.nullish(
  v.object({
    triage: ScheduleTriageSchema,
  }),
);

// Performance telemetry — disabled by default; auto-enabled by HEIMDALL_TELEMETRY_FILE env var.
const TelemetrySchema = v.nullish(
  v.object({
    enabled: v.nullish(v.boolean(), false),
    // File path for the JSON output blob. Omit to write to stderr.
    file: v.nullish(v.string()),
  }),
  { enabled: false },
);

// HTTP server config — used by `heimdall serve` mode.
const ServerSchema = v.nullish(
  v.object({
    // TCP port to listen on (default 3000). Override with HEIMDALL_PORT env var.
    port: v.nullish(v.number(), 3000),
    // Bind address (default '127.0.0.1' — loopback only). Override with HEIMDALL_HOST env var.
    host: v.nullish(v.string(), '127.0.0.1'),
  }),
  { port: 3000, host: '127.0.0.1' },
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
  // Performance telemetry: token usage, cache hit rate, tool-call latency (disabled by default).
  telemetry: TelemetrySchema,
  // HTTP server settings for `heimdall serve` mode (disabled by default; port 3000).
  server: ServerSchema,
});

export type HeimdallConfig = v.InferOutput<typeof HeimdallConfigSchema>;

// Typed against the schema so TypeScript enforces this map stays in sync when
// new tool keys are added to ToolsSchema — missing a key here is a compile error.
const KNOWN_TOOL_KEYS_MAP: Record<keyof NonNullable<HeimdallConfig['tools']>, true> = {
  kubectl: true,
  listContexts: true,
  listNamespaces: true,
  helmRelease: true,
  prometheusQuery: true,
  awsCli: true,
  trivyScan: true,
  kubecostQuery: true,
  lokiQuery: true,
  jaegerQuery: true,
  datadogQuery: true,
  newRelicQuery: true,
  cdkQuery: true,
};

const KNOWN_TOOL_KEYS = new Set(Object.keys(KNOWN_TOOL_KEYS_MAP));

// Accepted snake_case aliases → canonical camelCase key.
// Operators often copy the tool name the model sees (e.g. `list_contexts`)
// instead of the camelCase config key; accept both and convert silently.
// Typed against the schema key union so TypeScript enforces valid alias targets.
const SNAKE_CASE_ALIASES: Record<string, keyof NonNullable<HeimdallConfig['tools']>> = {
  list_contexts: 'listContexts',
  list_namespaces: 'listNamespaces',
  helm_release: 'helmRelease',
  prometheus_query: 'prometheusQuery',
  aws_cli: 'awsCli',
  trivy_scan: 'trivyScan',
  kubecost_query: 'kubecostQuery',
  loki_query: 'lokiQuery',
  jaeger_query: 'jaegerQuery',
  datadog_query: 'datadogQuery',
  new_relic_query: 'newRelicQuery',
  cdk_query: 'cdkQuery',
};

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

/**
 * Load and validate the Heimdall config file.
 *
 * @param configPath - explicit path override (used in tests); falls back to env / cwd.
 */
export function loadConfig(configPath?: string): HeimdallConfig {
  const filePath = configPath ?? resolveConfigPath();
  if (!existsSync(filePath)) return defaultConfig();

  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.warn(`[heimdall] Could not read config file ${filePath}:`, err);
    return defaultConfig();
  }

  // yaml.load returns a scalar (string, boolean, number) for degenerate files.
  if (raw !== null && raw !== undefined && typeof raw !== 'object') {
    console.warn(`[heimdall] Config at ${filePath} must be a YAML mapping, got ${typeof raw}`);
    return defaultConfig();
  }

  const rawObj = (raw ?? {}) as Record<string, unknown>;
  const tools = normalizeToolsBlock(rawObj['tools'], filePath);

  const result = v.safeParse(HeimdallConfigSchema, {
    ...rawObj,
    ...(tools !== undefined ? { tools } : {}),
  });
  if (!result.success) {
    console.warn(`[heimdall] Invalid config at ${filePath}:`, result.issues);
    return defaultConfig();
  }
  return result.output;
}
