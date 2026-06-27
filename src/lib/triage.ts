/**
 * Pure helpers for the triage diagnostic sweep.
 *
 * No I/O — all functions are deterministic and unit-testable without a cluster.
 */
import type { SloDefinition } from './slo.ts';

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
  /**
   * SLO definitions from the config.  When non-empty, an SLO evaluation step is
   * appended to the triage prompt and breaching SLOs are surfaced as HIGH severity findings.
   */
  slos?: SloDefinition[];
}

/** Severity levels for triage findings. */
export type Severity = 'critical' | 'warning' | 'info';

/** Ordered diagnostic categories — checked in this sequence every run. */
export const TRIAGE_CATEGORIES = ['nodes', 'pods', 'workloads', 'events', 'pvcs', 'jobs', 'capi'] as const;
export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

/** Resolved namespace scope strings derived from {@link TriageOptions}. */
export interface NamespaceScope {
  /** kubectl flag suffix: `''` | `' -n <ns>'` | `' -A'` */
  kubectlSuffix: string;
  /** Human-readable scope label for single-cluster prompts, e.g. `'namespace "prod"'` */
  scopeLabel: string;
  /** Prose suffix for multi-cluster descriptions, e.g. `' scoped to namespace "prod"'` */
  multiClusterSuffix: string;
}

/**
 * Derive namespace scope strings from triage options.
 *
 * Single source of truth for the three namespace representations used in
 * {@link buildTriagePrompt} and {@link buildMultiClusterTriagePrompt}.
 * `namespace` takes precedence over `allNamespaces` when both are set.
 */
export function resolveNamespaceScope(
  opts: Pick<TriageOptions, 'namespace' | 'allNamespaces'>,
): NamespaceScope {
  if (opts.namespace != null && opts.namespace !== '') {
    return {
      kubectlSuffix: ` -n ${opts.namespace}`,
      scopeLabel: `namespace "${opts.namespace}"`,
      multiClusterSuffix: ` scoped to namespace "${opts.namespace}"`,
    };
  }
  if (opts.allNamespaces) {
    return {
      kubectlSuffix: ' -A',
      scopeLabel: 'all namespaces',
      multiClusterSuffix: ' across all namespaces',
    };
  }
  return {
    kubectlSuffix: '',
    scopeLabel: 'the default namespace',
    multiClusterSuffix: '',
  };
}

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

  const { kubectlSuffix, scopeLabel } = resolveNamespaceScope(opts);

  return `Run a complete cluster health triage sweep scoped to ${scopeLabel}.
Work through ALL of the following checks in order. Do not skip any category.

1. **Nodes** — \`kubectl get nodes -o wide\`
   Flag: NotReady status; MemoryPressure, DiskPressure, or PIDPressure conditions; Unschedulable nodes.

2. **Pods** — \`kubectl get pods${kubectlSuffix} -o wide\`
   Flag: CrashLoopBackOff; ImagePullBackOff or ErrImagePull; OOMKilled; Pending > 5 min; ContainerCreating > 5 min; restart count > 5; any phase other than Running or Succeeded.

3. **Workloads** — \`kubectl get deployments,statefulsets,daemonsets${kubectlSuffix}\`
   Flag: unavailable replicas (READY < DESIRED). For any flagged workload, check \`kubectl rollout status deployment/<name> -n <ns> --timeout=5s\` to see if a rollout is stuck.

4. **Events** — \`kubectl get events${kubectlSuffix} --sort-by='.lastTimestamp'\`
   Report Warning-type events from the last hour. Group by reason.

5. **PVCs** — \`kubectl get pvc${kubectlSuffix}\`
   Flag: any PVC in Pending or Lost phase.

6. **Jobs** — \`kubectl get jobs${kubectlSuffix}\`
   Flag: any Job with failed completions (FAILED > 0) or that appears to be hung (COMPLETIONS shows 0/N and the job is old).

7. **CAPI drift** (Cluster API — skip if not installed) — \`kubectl api-resources --api-group=cluster.x-k8s.io\`
   If CAPI CRDs are present, run \`kubectl get machine,machinedeployment${kubectlSuffix} -o wide\` and delegate deep investigation to the \`capi-investigator\` subagent.
   Flag: Machines not in Running phase; MachineDeployments with READY < DESIRED.

For each finding provide:
- **Severity**: critical (cluster-impacting, service down), warning (degraded, at-risk), or info (advisory, not immediately harmful)
- **Resource**: kind and name with namespace, e.g. "Pod/api-7f9d in prod"
- **Message**: concise description of the problem
- **Suggested remediation**: the exact command the operator should run — never execute it yourself

End your answer with a one-line summary: "Triage complete: X critical, Y warning, Z info findings."${opts.slos && opts.slos.length > 0 ? `

${buildSloTriageStep(opts.slos)}` : ''}`;
}

/**
 * Build the SLO evaluation step for the triage prompt when SLOs are configured.
 * Each SLO metric is listed inline so the agent can query Prometheus for each one.
 */
function buildSloTriageStep(slos: SloDefinition[]): string {
  const sloList = slos
    .map(
      (s) =>
        `   - **${s.name}**: metric \`${s.metric}\` | budget ${s.budget} | target ${s.target} | window ${s.window}`,
    )
    .join('\n');

  return `8. **SLO evaluation** (requires \`prometheus_query\` tool) — delegate to \`slo-evaluator\` subagent.
   For each SLO below, call \`prometheus_query\` with an instant query for the metric, then compute:
     burn_rate = metric_value / budget
     remaining_budget = max(0, 1 − burn_rate)
   Flag any SLO where burn_rate > 1.0 as a **HIGH** severity finding with name, burn rate, and remaining budget.
   List healthy SLOs (burn_rate ≤ 1.0) in a "Healthy SLOs" summary table.

${sloList}`;
}

/**
 * Build a multi-cluster triage prompt that delegates cross-cluster investigation
 * to the `multi-cluster-investigator` subagent.
 */
function buildMultiClusterTriagePrompt(contexts: string[], opts: TriageOptions): string {
  const contextList = contexts.map((c) => `- ${c}`).join('\n');
  const { multiClusterSuffix } = resolveNamespaceScope(opts);

  return `Run a multi-cluster health triage sweep${multiClusterSuffix} across the following Kubernetes contexts:

${contextList}

Delegate this investigation to the \`multi-cluster-investigator\` subagent. It will:
1. Query each context listed above for all standard triage categories: node health, pod status, workload availability (deployments/statefulsets/daemonsets), recent warning events, PVC health (Pending/Lost), and failed/hung Jobs.
2. For each context, also check for CAPI drift: run \`kubectl api-resources --api-group=cluster.x-k8s.io\` per context; if CAPI CRDs are present, run \`kubectl get machine,machinedeployment -A -o wide\` and delegate CAPI investigation to the \`capi-investigator\` subagent.
3. Correlate findings across cluster boundaries to detect cross-cluster issues (shared service mesh problems, cross-cluster DNS failures, hub/spoke cascade failures, missing ServiceExport/ServiceImport endpoints).
4. Produce a per-cluster summary and a cross-cluster findings section.

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
