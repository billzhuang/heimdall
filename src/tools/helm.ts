/**
 * The `helm_release` tool: read-only Helm release inspection.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { runHelm } from '../lib/helm.ts';

export const helmRelease = defineTool({
  name: 'helm_release',
  description:
    'Inspect Helm releases in read-only mode. Three actions are supported:\n' +
    '- list: list releases in a namespace or across all namespaces.\n' +
    '- status: show the current status of a named release.\n' +
    '- get: retrieve the values, manifest, or notes for a named release.\n' +
    'Install, upgrade, rollback, and uninstall are never executed.',
  parameters: v.object({
    action: v.pipe(
      v.picklist(['list', 'status', 'get']),
      v.description(
        'Action to perform: "list" (enumerate releases), "status" (release health), or "get" (retrieve values/manifest/notes).',
      ),
    ),
    release: v.pipe(
      v.optional(v.string()),
      v.description('Release name. Required for the status and get actions.'),
    ),
    namespace: v.pipe(
      v.optional(v.string()),
      v.description(
        'Kubernetes namespace to scope the query. For list, omit to use the current namespace; combine with allNamespaces: true to list all.',
      ),
    ),
    getType: v.pipe(
      v.optional(v.picklist(['values', 'manifest', 'notes'])),
      v.description('What to retrieve for the get action: "values", "manifest", or "notes".'),
    ),
    allNamespaces: v.pipe(
      v.optional(v.boolean()),
      v.description('When true, list releases across every namespace (equivalent to helm list --all-namespaces).'),
    ),
  }),
  execute: async ({ action, release, namespace, getType, allNamespaces }) =>
    runHelm(action, { release, namespace, getType, allNamespaces }),
});
