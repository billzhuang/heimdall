/**
 * Model selection. Flue uses `provider/model` specifiers and resolves provider
 * credentials from the environment (e.g. `ANTHROPIC_API_KEY`). Override the
 * default with the `HEIMDALL_MODEL` environment variable.
 */
export const DEFAULT_MODEL = process.env.HEIMDALL_MODEL?.trim() || 'anthropic/claude-sonnet-4-6';

/**
 * Resolve the model to use, applying precedence: CLI flag > HEIMDALL_MODEL env var > DEFAULT_MODEL.
 * Throws a clear error if the flag value is not in "provider/model" format.
 */
export function resolveModel(cliFlag?: string): string {
  const model = cliFlag || DEFAULT_MODEL;
  const slashIdx = model.indexOf('/');
  if (slashIdx < 1 || slashIdx >= model.length - 1) {
    throw new Error(
      `Invalid model "${model}": expected "provider/model" format (e.g. "anthropic/claude-opus-4-8")`,
    );
  }
  return model;
}

/**
 * Like resolveModel, but returns undefined for an absent or invalid override
 * instead of falling back to DEFAULT_MODEL or throwing. Used by handlers that
 * read a model override from the environment (e.g. HEIMDALL_MODEL) and want a
 * clean value to `??` against their own default, rather than resolveModel's
 * baked-in fallback.
 */
export function resolveModelOrUndefined(cliFlag?: string): string | undefined {
  if (!cliFlag) return undefined;
  try {
    return resolveModel(cliFlag);
  } catch {
    return undefined;
  }
}
