/**
 * Infrastructure drift detection for Heimdall triage sweeps.
 *
 * On each triage run the caller:
 *   1. Loads the previous checkpoint from disk (`loadCheckpoint`)
 *   2. Builds a new snapshot of current cluster state (`buildCheckpoint`) and saves it
 *   3. Computes the drift between old and new (`detectDrift`)
 *   4. Injects the drift context into the triage prompt (`buildDriftPromptSection`)
 *
 * All functions that touch the filesystem are async; all diff / parse logic is pure.
 */
import { appendJsonlLine, readJsonlFile } from './jsonl.ts';

export interface WorkloadRef {
  kind: 'Deployment' | 'StatefulSet' | 'DaemonSet';
  namespace: string;
  name: string;
}

export interface NodeRef {
  name: string;
  status: string;
}

/** A point-in-time snapshot of cluster topology used as a drift baseline. */
export interface ClusterCheckpoint {
  /** ISO-8601 timestamp of when the snapshot was taken (also the entry ID). */
  timestamp: string;
  /** Namespace names present in the cluster. */
  namespaces: string[];
  /** Workloads (Deployments, StatefulSets, DaemonSets) across all namespaces. */
  workloads: WorkloadRef[];
  /** Nodes and their ready status. */
  nodes: NodeRef[];
}

export type DriftType =
  | 'new_workload'
  | 'deleted_workload'
  | 'new_namespace'
  | 'deleted_namespace'
  | 'topology_change';

export interface DriftFinding {
  type: DriftType;
  resource: string;
  message: string;
}

/** Build a blank checkpoint (used when bootstrapping the first baseline). */
export function buildEmptyCheckpoint(timestamp: string): ClusterCheckpoint {
  return { timestamp, namespaces: [], workloads: [], nodes: [] };
}

/** Append a checkpoint snapshot as a JSONL line (creates the file and parent dirs if absent). */
export async function saveCheckpoint(checkpoint: ClusterCheckpoint, filePath: string): Promise<void> {
  await appendJsonlLine(checkpoint, filePath);
}

/**
 * Read the most recent checkpoint from a JSONL file.
 * Returns null when the file does not exist or contains no parseable entries.
 */
export async function loadCheckpoint(filePath: string): Promise<ClusterCheckpoint | null> {
  const entries = await readJsonlFile<ClusterCheckpoint>(filePath);
  const valid = entries.filter((e) => typeof e?.timestamp === 'string');
  return valid.length > 0 ? valid[valid.length - 1] : null;
}

function workloadKey(w: WorkloadRef): string {
  return `${w.kind}/${w.namespace}/${w.name}`;
}

/** Return keys present only in `curr` (added) and only in `prev` (removed). */
function diffStringSet(prev: Set<string>, curr: Set<string>): { added: string[]; removed: string[] } {
  return {
    added: [...curr].filter((s) => !prev.has(s)),
    removed: [...prev].filter((s) => !curr.has(s)),
  };
}

/** Push one finding per added key and one per removed key into `findings`. */
function appendDiffFindings(
  findings: DriftFinding[],
  diff: { added: string[]; removed: string[] },
  makeAdded: (key: string) => DriftFinding,
  makeRemoved: (key: string) => DriftFinding,
): void {
  for (const key of diff.added) findings.push(makeAdded(key));
  for (const key of diff.removed) findings.push(makeRemoved(key));
}

function makeWorkloadFinding(type: 'new_workload' | 'deleted_workload', w: WorkloadRef): DriftFinding {
  const action =
    type === 'new_workload'
      ? 'appeared since the last triage run.'
      : 'was present at the last triage run but is now gone.';
  return {
    type,
    resource: `${w.kind}/${w.name} in ${w.namespace}`,
    message: `${w.kind} "${w.name}" in namespace "${w.namespace}" ${action}`,
  };
}

/**
 * Compare two snapshots and return classified drift findings.
 * Returns an empty array when `previous` is null (no baseline yet) or when
 * the cluster state is identical to the previous checkpoint.
 */
export function detectDrift(
  current: ClusterCheckpoint,
  previous: ClusterCheckpoint | null,
): DriftFinding[] {
  if (!previous) return [];
  const findings: DriftFinding[] = [];

  // Namespace changes
  appendDiffFindings(
    findings,
    diffStringSet(new Set(previous.namespaces), new Set(current.namespaces)),
    (ns) => ({ type: 'new_namespace', resource: `Namespace/${ns}`, message: `Namespace "${ns}" appeared since the last triage run.` }),
    (ns) => ({ type: 'deleted_namespace', resource: `Namespace/${ns}`, message: `Namespace "${ns}" was present at the last triage run but is now gone.` }),
  );

  // Workload changes
  const prevWl = new Map(previous.workloads.map((w) => [workloadKey(w), w]));
  const currWl = new Map(current.workloads.map((w) => [workloadKey(w), w]));
  appendDiffFindings(
    findings,
    diffStringSet(new Set(prevWl.keys()), new Set(currWl.keys())),
    (key) => makeWorkloadFinding('new_workload', currWl.get(key)!),
    (key) => makeWorkloadFinding('deleted_workload', prevWl.get(key)!),
  );

  // Node topology changes
  appendDiffFindings(
    findings,
    diffStringSet(new Set(previous.nodes.map((n) => n.name)), new Set(current.nodes.map((n) => n.name))),
    (name) => ({ type: 'topology_change', resource: `Node/${name}`, message: `Node "${name}" joined the cluster since the last triage run.` }),
    (name) => ({ type: 'topology_change', resource: `Node/${name}`, message: `Node "${name}" was present at the last triage run but is now absent.` }),
  );

  return findings;
}

/**
 * Format drift findings as a preamble section to prepend to the triage prompt.
 * Returns an empty string when there are no findings (no checkpoint, no changes).
 */
export function buildDriftPromptSection(
  findings: DriftFinding[],
  previousTimestamp: string,
): string {
  if (findings.length === 0) return '';
  const list = findings
    .map(
      (f, i) =>
        `${i + 1}. **${f.type}** — ${f.resource}: ${f.message}`,
    )
    .join('\n');
  return `## Infrastructure Drift Detected Since ${previousTimestamp}

The following changes were observed when comparing the current cluster state against the baseline recorded during the previous triage run. Treat new or deleted workloads as **warning** findings; topology changes (nodes added/removed) as **info** findings. Include all drift findings in your report before the regular triage categories.

${list}

---

`;
}

// ---------------------------------------------------------------------------
// Snapshot parsing helpers — extract minimal structs from kubectl -o json output
// ---------------------------------------------------------------------------

/**
 * Parse `raw` as JSON, extract `items`, and apply `extract` to them.
 * Returns [] on any JSON parse error or missing `items`.
 */
function parseJsonItems<T>(raw: string, extract: (items: unknown[]) => T[]): T[] {
  try {
    const obj = JSON.parse(raw) as { items?: unknown[] };
    return extract(obj.items ?? []);
  } catch {
    return [];
  }
}

/**
 * Parse a namespace list from `kubectl get namespaces -o json` output.
 * Returns an empty array on parse error or missing data.
 */
export function parseNamespacesFromJson(raw: string): string[] {
  return parseJsonItems(raw, (items) =>
    (items as Array<{ metadata?: { name?: string } }>)
      .map((item) => item?.metadata?.name ?? '')
      .filter(Boolean),
  );
}

/**
 * Parse a workload list from `kubectl get deployments,statefulsets,daemonsets -A -o json`.
 * Returns an empty array on parse error or missing data.
 */
export function parseWorkloadsFromJson(raw: string): WorkloadRef[] {
  return parseJsonItems(raw, (items) => {
    const results: WorkloadRef[] = [];
    for (const item of items as Array<{ kind?: string; metadata?: { name?: string; namespace?: string } }>) {
      const kind = item?.kind as WorkloadRef['kind'];
      if (!['Deployment', 'StatefulSet', 'DaemonSet'].includes(kind)) continue;
      const name = item?.metadata?.name;
      const namespace = item?.metadata?.namespace;
      if (name && namespace) results.push({ kind, namespace, name });
    }
    return results;
  });
}

/**
 * Parse a node list from `kubectl get nodes -o json`.
 * Returns an empty array on parse error or missing data.
 */
export function parseNodesFromJson(raw: string): NodeRef[] {
  return parseJsonItems(raw, (items) =>
    (items as Array<{ metadata?: { name?: string }; status?: { conditions?: Array<{ type?: string; status?: string }> } }>)
      .map((item) => {
        const name = item?.metadata?.name ?? '';
        const readyCond = item?.status?.conditions?.find((c) => c?.type === 'Ready');
        const status = readyCond?.status === 'True' ? 'Ready' : 'NotReady';
        return { name, status };
      })
      .filter((n) => Boolean(n.name)),
  );
}
