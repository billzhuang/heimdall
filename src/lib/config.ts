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
  }),
  { kubectl: true, listContexts: true, listNamespaces: true, helmRelease: true },
);

const AuditSchema = v.nullish(
  v.object({
    enabled: v.nullish(v.boolean(), false),
    // Omit `file` (or set it to null/empty) to write to stderr.
    file: v.nullish(v.string()),
  }),
  { enabled: false },
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

const HeimdallConfigSchema = v.object({
  tools: ToolsSchema,
  audit: AuditSchema,
  watch: WatchSchema,
  // Redact Secret .data / .stringData values in kubectl output (code-enforced, default on).
  redactSecrets: v.nullish(v.boolean(), true),
});

export type HeimdallConfig = v.InferOutput<typeof HeimdallConfigSchema>;

// Typed against the schema so TypeScript enforces this map stays in sync when
// new tool keys are added to ToolsSchema — missing a key here is a compile error.
const KNOWN_TOOL_KEYS_MAP: Record<keyof NonNullable<HeimdallConfig['tools']>, true> = {
  kubectl: true,
  listContexts: true,
  listNamespaces: true,
  helmRelease: true,
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
