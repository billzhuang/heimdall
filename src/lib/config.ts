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
  }),
  { kubectl: true, listContexts: true, listNamespaces: true },
);

const HeimdallConfigSchema = v.object({
  tools: ToolsSchema,
});

export type HeimdallConfig = v.InferOutput<typeof HeimdallConfigSchema>;

// Typed against the schema so TypeScript enforces this map stays in sync when
// new tool keys are added to ToolsSchema — missing a key here is a compile error.
const KNOWN_TOOL_KEYS_MAP: Record<keyof NonNullable<HeimdallConfig['tools']>, true> = {
  kubectl: true,
  listContexts: true,
  listNamespaces: true,
};

const KNOWN_TOOL_KEYS = new Set(Object.keys(KNOWN_TOOL_KEYS_MAP));

// Common snake_case mistakes (the model sees these names, operators may copy them verbatim).
const SNAKE_CASE_ALIASES: Record<string, keyof NonNullable<HeimdallConfig['tools']>> = {
  list_contexts: 'listContexts',
  list_namespaces: 'listNamespaces',
};

function warnUnknownToolKeys(tools: unknown, filePath: string): void {
  if (tools === null || tools === undefined || typeof tools !== 'object' || Array.isArray(tools)) return;
  for (const key of Object.keys(tools as object)) {
    if (KNOWN_TOOL_KEYS.has(key)) continue;
    const alias = SNAKE_CASE_ALIASES[key];
    const hint = alias
      ? ` — did you mean "${alias}"?`
      : `. Known keys: ${[...KNOWN_TOOL_KEYS].join(', ')}`;
    console.warn(`[heimdall] Config ${filePath}: unknown tools key "${key}"${hint}`);
  }
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
  warnUnknownToolKeys(rawObj['tools'], filePath);

  const result = v.safeParse(HeimdallConfigSchema, rawObj);
  if (!result.success) {
    console.warn(`[heimdall] Invalid config at ${filePath}:`, result.issues);
    return defaultConfig();
  }
  return result.output;
}
