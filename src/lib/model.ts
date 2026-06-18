/**
 * Model selection. Flue uses `provider/model` specifiers and resolves provider
 * credentials from the environment (e.g. `ANTHROPIC_API_KEY`). Override the
 * default with the `HEIMDALL_MODEL` environment variable.
 */
export const DEFAULT_MODEL = process.env.HEIMDALL_MODEL ?? 'anthropic/claude-sonnet-4-6';
