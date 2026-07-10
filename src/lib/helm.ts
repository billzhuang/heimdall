/**
 * Read-only Helm inspection for Heimdall.
 *
 * Only three Helm commands are allowed:
 *   helm list   — enumerate releases (all or scoped to a namespace)
 *   helm status — show the current status of a release
 *   helm get    — retrieve values, manifest, or notes for a release
 *
 * All argv is assembled in code (never from a shell string) and passed to
 * execFile so model-supplied release names and namespaces cannot inject shell
 * metacharacters.
 */
import { makeTruncate } from './output-truncation.ts';
import { execAndReport, DEFAULT_NO_OUTPUT_MESSAGE } from './cli-exec.ts';
import { resolveNamespaceLockdown } from './tool-config.ts';

const EXEC_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_RESULT_CHARS = 100_000;
const truncate = makeTruncate(MAX_RESULT_CHARS, 'narrow the query with -n <namespace> or a specific release name');

export const ALLOWED_HELM_ACTIONS = ['list', 'status', 'get'] as const;
export type HelmAction = (typeof ALLOWED_HELM_ACTIONS)[number];

export const ALLOWED_HELM_GET_TYPES = ['values', 'manifest', 'notes'] as const;
export type HelmGetType = (typeof ALLOWED_HELM_GET_TYPES)[number];

export interface RunHelmOptions {
  release?: string;
  namespace?: string;
  getType?: HelmGetType;
  allNamespaces?: boolean;
}

/** Result of {@link resolveHelmNamespaceLockdown}: either the resolved query params, or a blocked-response reason. */
export type HelmNamespaceLockdownResult =
  | { blocked: true; reason: string }
  | { blocked: false; namespace: string | undefined; allNamespaces: boolean | undefined };

/**
 * Resolve the effective namespace/allNamespaces for a helm_release query,
 * applying namespace lockdown when configured.
 *
 * When no namespace is locked, the caller-requested namespace and
 * allNamespaces pass through unchanged. When locked, `allNamespaces` and any
 * conflicting namespace are blocked; an unset namespace defaults to the
 * locked namespace.
 */
export function resolveHelmNamespaceLockdown(
  namespace: string | undefined,
  allNamespaces: boolean | undefined,
  lockedNamespace: string | null | undefined,
): HelmNamespaceLockdownResult {
  if (!lockedNamespace) return { blocked: false, namespace, allNamespaces };
  if (allNamespaces) {
    return {
      blocked: true,
      reason: `namespace lockdown is active — 'allNamespaces' is not allowed; only '${lockedNamespace}' is accessible`,
    };
  }
  // Empty string is treated as omitted, matching how some LLM providers send
  // "" rather than omitting an optional field (see getType handling in
  // tools/helm.ts).
  const result = resolveNamespaceLockdown(namespace || undefined, lockedNamespace);
  if (result.blocked) {
    return {
      blocked: true,
      reason: `namespace lockdown is active — only '${lockedNamespace}' is accessible; '${namespace}' is not allowed`,
    };
  }
  return { blocked: false, namespace: result.namespace, allNamespaces: false };
}

/** Returns an error string if `value` starts with a hyphen (option injection), else null. */
function leadingHyphenError(value: string | undefined, label: string): string | null {
  return value?.startsWith('-') ? `Error: ${label} cannot start with a hyphen.` : null;
}

/** Appends `-n <namespace>` to argv when namespace is set. */
function pushNamespaceFlag(argv: string[], namespace: string | undefined): void {
  if (namespace) argv.push('-n', namespace);
}

/**
 * Run a read-only Helm command. Returns the output (or a descriptive error)
 * as a string suitable for returning to the model.
 *
 * Input validation happens here so the function is testable in isolation
 * without spawning a real `helm` binary.
 */
export async function runHelm(action: HelmAction, options: RunHelmOptions = {}): Promise<string> {
  const { release, namespace, getType, allNamespaces } = options;

  // Reject names starting with '-': execFile prevents shell injection, but helm
  // would still parse such values as flags (option injection / argument injection).
  // Valid Helm release names and Kubernetes namespaces never start with a hyphen.
  const hyphenError = leadingHyphenError(release, 'release name') ?? leadingHyphenError(namespace, 'namespace');
  if (hyphenError) return hyphenError;

  let argv: string[];

  if (action === 'list') {
    argv = ['list'];
    if (allNamespaces) {
      argv.push('--all-namespaces');
    } else {
      pushNamespaceFlag(argv, namespace);
    }
  } else if (action === 'status') {
    if (!release) return 'Error: release name is required for the status action.';
    argv = ['status', release];
    pushNamespaceFlag(argv, namespace);
  } else if (action === 'get') {
    if (!release) return 'Error: release name is required for the get action.';
    if (!getType) return 'Error: getType is required for the get action (values, manifest, or notes).';
    if (!ALLOWED_HELM_GET_TYPES.includes(getType)) {
      return `Error: invalid getType '${getType}'. Must be one of: ${ALLOWED_HELM_GET_TYPES.join(', ')}.`;
    }
    argv = ['get', getType, release];
    pushNamespaceFlag(argv, namespace);
  } else {
    // Exhaustive guard — TypeScript ensures HelmAction is one of the above.
    return `Error: unknown helm action '${action as string}'. Allowed: ${ALLOWED_HELM_ACTIONS.join(', ')}.`;
  }

  const startTs = new Date().toISOString();
  const startMs = Date.now();

  return execAndReport({
    bin: 'helm',
    argv,
    cmd: `helm ${argv.join(' ')}`,
    startTs,
    startMs,
    execOptions: { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
    noOutputMessage: DEFAULT_NO_OUTPUT_MESSAGE,
    truncate,
  });
}
