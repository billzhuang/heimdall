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
  }),
  { kubectl: true, listContexts: true, listNamespaces: true, helmRelease: true, prometheusQuery: false, awsCli: false },
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


const HeimdallConfigSchema = v.object({
  tools: ToolsSchema,
  audit: AuditSchema,
  watch: WatchSchema,
  // Redact Secret .data / .stringData values in kubectl output (code-enforced, default on).
  redactSecrets: v.nullish(v.boolean(), true),
  prometheus: PrometheusSchema,
  // User-configurable regex redaction rules (disabled by default).
  redaction: RedactionSchema,
  namespace: NamespaceSchema,
  // Local markdown runbooks loaded into system context at startup.
  runbooks: v.nullish(v.array(RunbookEntrySchema), []),
  // Slack notification sink (disabled by default).
  slack: SlackSchema,
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
