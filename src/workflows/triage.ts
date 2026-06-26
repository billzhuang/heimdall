/**
 * Heimdall triage workflow.
 *
 * A Flue workflow that runs a structured cluster health sweep using the
 * Heimdall agent and returns a severity-ranked report.
 *
 * Run one-shot:
 *   flue run triage --target node
 *   flue run triage --target node --input '{"namespace":"prod"}'
 *   flue run triage --target node --input '{"allNamespaces":true}'
 *
 * Expose over HTTP (add to src/workflows/triage.ts):
 *   export const route: WorkflowRouteHandler = async (_c, next) => next();
 *
 * Schedule externally (cron example):
 *   0 *\/6 * * *  npx flue run triage --target node
 */
import { defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';
import heimdallAgent from '../agents/heimdall.ts';
import { buildTriagePrompt } from '../lib/triage.ts';
import { loadConfig } from '../lib/config.ts';

const TriageInputSchema = v.object({
  namespace: v.optional(v.string()),
  allNamespaces: v.optional(v.boolean()),
  contexts: v.optional(v.array(v.string())),
});

export default defineWorkflow({
  agent: heimdallAgent,
  input: TriageInputSchema,
  run: async ({ harness, input }) => {
    const config = loadConfig();
    const slos = config.tools.prometheusQuery ? (config.slos ?? []) : [];
    const session = await harness.session();
    const response = await session.prompt(buildTriagePrompt({ ...input, slos }));
    return { report: response.text };
  },
});
