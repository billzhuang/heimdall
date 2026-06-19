/**
 * The `kubectl` tool: the agent's only path to the cluster, and a read-only one.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { runKubectl, type AuditConfig } from '../lib/kubectl.ts';

export function makeKubectl(audit?: AuditConfig | null, redactSecrets?: boolean) {
  return defineTool({
    name: 'kubectl',
    description:
      'Run a single READ-ONLY kubectl command against the cluster and return its output. ' +
      'Provide everything after the word "kubectl" in `args` (for example: ' +
      '"get pods -n kube-system -o wide", "describe deployment api -n prod", or ' +
      '"wait --for=condition=Ready pod/web -n prod"). ' +
      'Destructive subcommands (apply, create, delete, patch, edit, scale, exec, ' +
      'port-forward, ...) are blocked. For rollout: only "status" and "history" are allowed; ' +
      'restart/undo/pause/resume are blocked. There is no shell, so pipes/redirects do not work — ' +
      'use label selectors, --field-selector, or -o jsonpath to filter output. ' +
      'Treat Secret .data and .stringData values as sensitive regardless of output format.',
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
    execute: async ({ args, context }) => runKubectl(args, { context, audit, redactSecrets }),
  });
}

export const kubectl = makeKubectl();
