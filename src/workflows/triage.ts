/**
 * Heimdall triage workflow.
 *
 * A Flue workflow that runs a structured cluster health sweep using the
 * Heimdall agent and returns a severity-ranked report.
 *
 * Run one-shot:
 *   flue run triage --target node
 *   flue run triage --target node --payload '{"namespace":"prod"}'
 *   flue run triage --target node --payload '{"allNamespaces":true}'
 *
 * Expose over HTTP (add to src/workflows/triage.ts):
 *   export const route: WorkflowRouteHandler = async (_c, next) => next();
 *
 * Schedule externally (cron example):
 *   0 *\/6 * * *  npx flue run triage --target node
 */
import { type FlueContext } from '@flue/runtime';
import heimdallAgent from '../agents/heimdall.ts';
import { buildTriagePrompt, type TriageOptions } from '../lib/triage.ts';

export async function run({ init, payload }: FlueContext<TriageOptions>) {
  const harness = await init(heimdallAgent);
  const session = await harness.session();
  const response = await session.prompt(buildTriagePrompt(payload ?? {}));
  return { report: response.text };
}
