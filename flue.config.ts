import { defineConfig } from '@flue/cli/config';

/**
 * Build-time configuration for the Flue CLI. Heimdall builds to a Node.js
 * target; provider credentials (e.g. ANTHROPIC_API_KEY) are read from the
 * environment at runtime, not configured here.
 */
export default defineConfig({
  target: 'node',
});
