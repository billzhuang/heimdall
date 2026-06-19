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

const ToolsSchema = v.optional(
  v.object({
    kubectl: v.optional(v.boolean(), true),
    listContexts: v.optional(v.boolean(), true),
    listNamespaces: v.optional(v.boolean(), true),
  }),
  { kubectl: true, listContexts: true, listNamespaces: true },
);

const HeimdallConfigSchema = v.object({
  tools: ToolsSchema,
});

export type HeimdallConfig = v.InferOutput<typeof HeimdallConfigSchema>;

const DEFAULT_CONFIG: HeimdallConfig = {
  tools: { kubectl: true, listContexts: true, listNamespaces: true },
};

function resolveConfigPath(): string {
  const envPath = process.env.HEIMDALL_CONFIG;
  if (envPath) return resolve(envPath);
  return resolve(process.cwd(), 'heimdall.config.yaml');
}

/**
 * Load and validate the Heimdall config file.  Returns defaults when the file
 * does not exist; logs a warning and returns defaults when the file is invalid.
 *
 * @param configPath - explicit path (used in tests); falls back to env / cwd.
 */
export function loadConfig(configPath?: string): HeimdallConfig {
  const filePath = configPath ?? resolveConfigPath();
  if (!existsSync(filePath)) return DEFAULT_CONFIG;

  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.warn(`[heimdall] Could not read config file ${filePath}:`, err);
    return DEFAULT_CONFIG;
  }

  const result = v.safeParse(HeimdallConfigSchema, raw ?? {});
  if (!result.success) {
    console.warn(`[heimdall] Invalid config at ${filePath}:`, result.issues);
    return DEFAULT_CONFIG;
  }
  return result.output;
}
