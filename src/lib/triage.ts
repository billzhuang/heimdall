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
 */
export function buildTriagePrompt(opts: TriageOptions = {}): string {
  const nsFlag = opts.namespace ? `-n ${opts.namespace}` : '-A';
  const scope = opts.namespace
    ? `namespace "${opts.namespace}"`
    : opts.allNamespaces
      ? 'all namespaces'
      : 'the default namespace (use -A if you want all namespaces)';

  return `Run a complete cluster health triage sweep scoped to ${scope}.
Work through ALL of the following checks in order. Do not skip any category.

1. **Nodes** — \`kubectl get nodes -o wide\`
   Flag: NotReady status; MemoryPressure, DiskPressure, or PIDPressure conditions; Unschedulable nodes.

2. **Pods** — \`kubectl get pods ${nsFlag} -o wide\`
   Flag: CrashLoopBackOff; ImagePullBackOff or ErrImagePull; OOMKilled; Pending > 5 min; ContainerCreating > 5 min; restart count > 5; any phase other than Running or Succeeded.

3. **Workloads** — \`kubectl get deployments,statefulsets,daemonsets ${nsFlag}\`
   Flag: unavailable replicas (READY < DESIRED). For any flagged workload, check \`kubectl rollout status deployment/<name> -n <ns>\` to see if a rollout is stuck.

4. **Events** — \`kubectl get events ${nsFlag} --sort-by='.lastTimestamp'\`
   Report Warning-type events from the last hour. Group by reason.

5. **PVCs** — \`kubectl get pvc ${nsFlag}\`
   Flag: any PVC in Pending or Lost phase.

6. **Jobs** — \`kubectl get jobs ${nsFlag}\`
   Flag: any Job with failed completions (FAILED > 0) or that appears to be hung (COMPLETIONS shows 0/N and the job is old).

For each finding provide:
- **Severity**: critical (cluster-impacting, service down), warning (degraded, at-risk), or info (advisory, not immediately harmful)
- **Resource**: kind and name with namespace, e.g. "Pod/api-7f9d in prod"
- **Message**: concise description of the problem
- **Suggested remediation**: the exact command the operator should run — never execute it yourself

End your answer with a one-line summary: "Triage complete: X critical, Y warning, Z info findings."`;
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
