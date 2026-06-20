/**
 * Pure helpers for the triage diagnostic sweep.
 *
 * No I/O — all functions are deterministic and unit-testable without a cluster.
 */

export interface TriageOptions {
  /** Scope the sweep to a single namespace. */
  namespace?: string;
  /** Scan all namespaces (overrides `namespace`). */
  allNamespaces?: boolean;
  /**
   * Run the sweep across multiple kubeconfig contexts (comma-separated or array).
   * When set, the agent delegates to `multi-cluster-investigator` to query each
   * context and correlate cross-cluster findings.
   */
  contexts?: string[];
}

/** Severity levels for triage findings. */
export type Severity = 'critical' | 'warning' | 'info';

/** Ordered diagnostic categories — checked in this sequence every run. */
export const TRIAGE_CATEGORIES = ['nodes', 'pods', 'workloads', 'events', 'pvcs', 'jobs'] as const;
export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

/**
 * Build the structured triage prompt sent to the Heimdall agent.
 *
 * The prompt instructs the agent to run all checks in a fixed order so every
 * triage run is repeatable and comparable.
 *
 * When `opts.contexts` is set, the prompt triggers a multi-cluster sweep via
 * the `multi-cluster-investigator` subagent instead of a single-cluster check.
 */
export function buildTriagePrompt(opts: TriageOptions = {}): string {
  if (opts.contexts && opts.contexts.length > 0) {
    return buildMultiClusterTriagePrompt(opts.contexts, opts);
  }

  const nsSuffix = opts.namespace
    ? ` -n ${opts.namespace}`
    : opts.allNamespaces
      ? ' -A'
      : '';
  const scope = opts.namespace
    ? `namespace "${opts.namespace}"`
    : opts.allNamespaces
      ? 'all namespaces'
      : 'the default namespace';

  return `Run a complete cluster health triage sweep scoped to ${scope}.
Work through ALL of the following checks in order. Do not skip any category.

1. **Nodes** — \`kubectl get nodes -o wide\`
   Flag: NotReady status; MemoryPressure, DiskPressure, or PIDPressure conditions; Unschedulable nodes.

2. **Pods** — \`kubectl get pods${nsSuffix} -o wide\`
   Flag: CrashLoopBackOff; ImagePullBackOff or ErrImagePull; OOMKilled; Pending > 5 min; ContainerCreating > 5 min; restart count > 5; any phase other than Running or Succeeded.

3. **Workloads** — \`kubectl get deployments,statefulsets,daemonsets${nsSuffix}\`
   Flag: unavailable replicas (READY < DESIRED). For any flagged workload, check \`kubectl rollout status deployment/<name> -n <ns> --timeout=5s\` to see if a rollout is stuck.

4. **Events** — \`kubectl get events${nsSuffix} --sort-by='.lastTimestamp'\`
   Report Warning-type events from the last hour. Group by reason.

5. **PVCs** — \`kubectl get pvc${nsSuffix}\`
   Flag: any PVC in Pending or Lost phase.

6. **Jobs** — \`kubectl get jobs${nsSuffix}\`
   Flag: any Job with failed completions (FAILED > 0) or that appears to be hung (COMPLETIONS shows 0/N and the job is old).

For each finding provide:
- **Severity**: critical (cluster-impacting, service down), warning (degraded, at-risk), or info (advisory, not immediately harmful)
- **Resource**: kind and name with namespace, e.g. "Pod/api-7f9d in prod"
- **Message**: concise description of the problem
- **Suggested remediation**: the exact command the operator should run — never execute it yourself

End your answer with a one-line summary: "Triage complete: X critical, Y warning, Z info findings."`;
}

/**
 * Build a multi-cluster triage prompt that delegates cross-cluster investigation
 * to the `multi-cluster-investigator` subagent.
 */
function buildMultiClusterTriagePrompt(contexts: string[], opts: TriageOptions): string {
  const contextList = contexts.map((c) => `- ${c}`).join('\n');
  const nsSuffix = opts.namespace
    ? ` scoped to namespace "${opts.namespace}"`
    : opts.allNamespaces
      ? ' across all namespaces'
      : '';

  return `Run a multi-cluster health triage sweep${nsSuffix} across the following Kubernetes contexts:

${contextList}

Delegate this investigation to the \`multi-cluster-investigator\` subagent. It will:
1. Query each context listed above for all standard triage categories: node health, pod status, workload availability (deployments/statefulsets/daemonsets), recent warning events, PVC health (Pending/Lost), and failed/hung Jobs.
2. Correlate findings across cluster boundaries to detect cross-cluster issues (shared service mesh problems, cross-cluster DNS failures, hub/spoke cascade failures, missing ServiceExport/ServiceImport endpoints).
3. Produce a per-cluster summary and a cross-cluster findings section.

After the subagent reports, synthesise its findings into your final answer following the standard response format. End with a summary line: "Multi-cluster triage complete: X clusters swept, Y cross-cluster issues found, Z total findings."`;
}

/**
 * Parse a severity label from free-form text (case-insensitive).
 * Returns undefined if no recognised level is found.
 */
export function parseSeverity(text: string): Severity | undefined {
  const lower = text.toLowerCase();
  if (lower.includes('critical')) return 'critical';
  if (lower.includes('warning')) return 'warning';
  if (lower.includes('info')) return 'info';
  return undefined;
}

/**
 * Compare two severity values for sorting: critical > warning > info.
 * Returns negative if a > b, 0 if equal, positive if a < b.
 */
export function compareSeverity(a: Severity, b: Severity): number {
  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  return rank[a] - rank[b];
}
