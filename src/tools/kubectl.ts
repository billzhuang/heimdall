/**
 * The `kubectl` tool: the agent's only path to the cluster, and a read-only one.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { runKubectl } from '../lib/kubectl.ts';

export const kubectl = defineTool({
  name: 'kubectl',
  description:
    'Run a single READ-ONLY kubectl command against the cluster and return its output. ' +
    'Provide everything after the word "kubectl" in `args` (for example: ' +
    '"get pods -n kube-system -o wide" or "describe deployment api -n prod"). ' +
    'Destructive subcommands (apply, create, delete, patch, edit, scale, rollout, exec, ' +
    'port-forward, ...) are blocked. There is no shell, so pipes/redirects do not work — ' +
    'use label selectors, --field-selector, or -o jsonpath to filter output.',
  parameters: v.object({
    args: v.pipe(
      v.string(),
      v.description('Arguments passed to kubectl, excluding the leading "kubectl".'),
    ),
    context: v.pipe(
      v.optional(v.string()),
      v.description('Optional cluster context to target (added as --context=...). Defaults to the configured/current context.'),
    ),
  }),
  execute: async ({ args, context }) => runKubectl(args, { context }),
});
