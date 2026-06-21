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
  if (!model.includes('/')) {
    throw new Error(
      `Invalid model "${model}": expected "provider/model" format (e.g. "anthropic/claude-opus-4-8")`,
    );
  }
  return model;
}
