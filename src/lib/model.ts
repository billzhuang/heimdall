/**
 * Model selection. Flue uses `provider/model` specifiers and resolves provider
 * credentials from the environment (e.g. `ANTHROPIC_API_KEY`). Override the
 * default with the `HEIMDALL_MODEL` environment variable.
 */
export const DEFAULT_MODEL = process.env.HEIMDALL_MODEL ?? 'anthropic/claude-sonnet-4-6';

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
 * Like resolveModel, but treats an invalid override as unset rather than
 * throwing. Used by handlers that read a model override from the environment
 * (e.g. HEIMDALL_MODEL) and must fall back gracefully instead of crashing.
 */
export function resolveModelOrUndefined(cliFlag?: string): string | undefined {
  try {
    return resolveModel(cliFlag);
  } catch {
    return undefined;
  }
}
