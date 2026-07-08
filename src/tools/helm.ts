/**
 * The `helm_release` tool: read-only Helm release inspection.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { runHelm, ALLOWED_HELM_ACTIONS, ALLOWED_HELM_GET_TYPES, resolveHelmNamespaceLockdown } from '../lib/helm.ts';
import { BLOCKED_PREFIX } from '../lib/harness.ts';
import type { ToolPlugin } from '../lib/plugin.ts';
import { buildLockdownNote } from '../lib/tool-config.ts';

export function makeHelmRelease(lockedNamespace?: string | null) {
  const lockdownNote = buildLockdownNote(
    lockedNamespace,
    (ns) => `only namespace '${ns}' is accessible; allNamespaces and other namespaces are blocked.`,
  );
  return defineTool({
    name: 'helm_release',
    description:
      'Inspect Helm releases in read-only mode. Three actions are supported:\n' +
      '- list: list releases in a namespace or across all namespaces.\n' +
      '- status: show the current status of a named release.\n' +
      '- get: retrieve the values, manifest, or notes for a named release.\n' +
      'Install, upgrade, rollback, and uninstall are never executed.' +
      lockdownNote,
    input: v.object({
      action: v.pipe(
        v.picklist(ALLOWED_HELM_ACTIONS),
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
        v.nullish(v.picklist(ALLOWED_HELM_GET_TYPES)),
        v.description('What to retrieve for the get action: "values", "manifest", or "notes".'),
      ),
      allNamespaces: v.pipe(
        v.optional(v.boolean()),
        v.description('When true, list releases across every namespace (equivalent to helm list --all-namespaces).'),
      ),
    }),
    run: async ({ input: { action, release, namespace, getType, allNamespaces } }) => {
      // getType is nullish (LLM providers may send an explicit `null` for an
      // omitted optional field); normalize to undefined for RunHelmOptions.
      const resolvedGetType = getType ?? undefined;
      const lockdown = resolveHelmNamespaceLockdown(namespace, allNamespaces, lockedNamespace);
      if (lockdown.blocked) {
        return `${BLOCKED_PREFIX}${lockdown.reason}`;
      }
      return runHelm(action, {
        release,
        namespace: lockdown.namespace,
        getType: resolvedGetType,
        allNamespaces: lockdown.allNamespaces,
      });
    },
  });
}

export const helmRelease = makeHelmRelease();

export const helmReleasePlugin: ToolPlugin = {
  key: 'helmRelease',
  factory: (config) => makeHelmRelease(config.namespace?.locked),
};
