/**
 * Heimdall triage mode.
 *
 * Runs a structured whole-cluster health sweep by calling the Heimdall agent
 * with a detailed triage prompt. The agent performs all kubectl reads and
 * returns a severity-ranked report (critical / warning / info).
 *
 * Usage:
 *   npm run triage
 *   npm run triage -- -n prod
 *   npm run triage -- -A
 *   heimdall triage [-n <namespace>] [-A]
 *
 * The report streams to stdout as the agent writes it. Exit code 0 means the
 * sweep completed (findings may still be present); non-zero means the agent
 * failed or timed out.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTriagePrompt, type TriageOptions } from './lib/triage.ts';
import { resolveModel } from './lib/model.ts';
import { loadConfig } from './lib/config.ts';
import { parseTriageFindings, upsertBaseline, resolveBaselineFilePath } from './lib/baseline.ts';
import {
  loadCheckpoint,
  saveCheckpoint,
  detectDrift,
  buildDriftPromptSection,
  parseNamespacesFromJson,
  parseWorkloadsFromJson,
  parseNodesFromJson,
  type ClusterCheckpoint,
} from './lib/drift.ts';
import { runKubectl } from './lib/kubectl.ts';
import { getMessage, getStackOrMessage } from './lib/error-utils.ts';
import { resolveBinPath } from './lib/bin-path.ts';
import { interpretChildExit } from './lib/child-exit.ts';
import { spawnAndCollect } from './lib/spawn-collect.ts';
import { requireNextArg, requireNonEmptyValue, parseCommaSeparatedList, parseModelFlag, isMainModule } from './lib/cli-args.ts';

const TRIAGE_TIMEOUT_MS = 300_000; // 5 minutes — a full sweep needs time

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Invoke the Heimdall agent with a prompt.
 * Streams output to stdout (tee) and also returns the full captured text so
 * callers can parse findings for baseline writing.
 */
async function runAgent(prompt: string, model?: string): Promise<string> {
  const binPath = resolveBinPath(__dirname);
  const env = model ? { ...process.env, HEIMDALL_MODEL: model } : process.env;

  return spawnAndCollect(binPath, ['-p', prompt], {
    env,
    timeoutMs: TRIAGE_TIMEOUT_MS,
    stdio: 'tee',
    onTimeout: () => new Error('triage timed out after 5 minutes'),
    onExit: (code, signal) => interpretChildExit(code, signal),
  });
}

// Resolve relative to the package root so the checkpoint sits alongside
// task-history.jsonl regardless of the process working directory.
const DEFAULT_CHECKPOINT_FILE = resolve(__dirname, '..', 'scenarios', 'drift-checkpoint.jsonl');

/**
 * Capture a lightweight cluster snapshot using direct kubectl reads.
 *
 * Returns null when ALL three kubectl calls fail (non-JSON responses), which
 * indicates kubectl is unavailable or the cluster is unreachable — in that case
 * the caller must NOT overwrite the existing baseline with an empty snapshot.
 *
 * When `lockedNamespace` is set the workload query is scoped to that namespace
 * and the options are forwarded to runKubectl so the lockdown policy applies.
 */
async function captureCheckpoint(
  timestamp: string,
  lockedNamespace?: string,
): Promise<ClusterCheckpoint | null> {
  const opts = lockedNamespace ? { lockedNamespace } : {};
  // When namespace is locked, scope workloads to that namespace instead of -A
  // (which applyNamespaceLockdown would block anyway).
  const wlArgs = lockedNamespace
    ? `get deployments,statefulsets,daemonsets -n ${lockedNamespace} -o json`
    : 'get deployments,statefulsets,daemonsets -A -o json';
  const [nsRaw, wlRaw, nodeRaw] = await Promise.all([
    runKubectl('get namespaces -o json', opts).catch(() => ''),
    runKubectl(wlArgs, opts).catch(() => ''),
    runKubectl('get nodes -o json', opts).catch(() => ''),
  ]);
  // If none of the responses look like JSON objects, kubectl is unavailable or
  // all commands were blocked — skip saving so we don't overwrite a good baseline
  // with an all-empty snapshot that would trigger spurious drift findings next run.
  const hasJsonData = [nsRaw, wlRaw, nodeRaw].some((raw) => raw.trimStart().startsWith('{'));
  if (!hasJsonData) return null;
  return {
    timestamp,
    namespaces: parseNamespacesFromJson(nsRaw),
    workloads: parseWorkloadsFromJson(wlRaw),
    nodes: parseNodesFromJson(nodeRaw),
  };
}

/**
 * Build the startup log lines announcing sweep scope: single- vs multi-cluster,
 * and namespace vs all-namespaces vs default.
 */
export function buildSweepStartupMessages(opts: TriageOptions): string[] {
  const messages: string[] = [];
  messages.push(
    opts.contexts && opts.contexts.length > 0
      ? `[heimdall-triage] Starting multi-cluster sweep across: ${opts.contexts.join(', ')}`
      : '[heimdall-triage] Starting cluster health sweep...',
  );
  if (opts.namespace) {
    messages.push(`[heimdall-triage] Scope: namespace "${opts.namespace}"`);
  } else if (opts.allNamespaces) {
    messages.push('[heimdall-triage] Scope: all namespaces');
  }
  return messages;
}

type LoadedConfig = ReturnType<typeof loadConfig>;

/**
 * Load the previous checkpoint, capture current cluster state, save it, and
 * return a drift preamble to prepend to the triage prompt (or '' when drift
 * detection is disabled, unavailable, or there is no previous checkpoint to
 * diff against).
 */
async function performDriftDetection(config: LoadedConfig): Promise<string> {
  if (!(config.drift?.enabled ?? false)) return '';

  const checkpointFile = config.drift?.checkpointFile ?? DEFAULT_CHECKPOINT_FILE;
  const now = new Date().toISOString();
  const lockedNamespace = config.namespace?.locked ?? undefined;
  const [previous, current] = await Promise.all([
    loadCheckpoint(checkpointFile).catch(() => null),
    captureCheckpoint(now, lockedNamespace),
  ]);

  if (!current) {
    process.stderr.write(`[heimdall-triage] Drift snapshot skipped — kubectl unavailable or cluster unreachable\n`);
    return '';
  }

  // Save the new checkpoint only when we got real data from the cluster.
  saveCheckpoint(current, checkpointFile).catch((err: unknown) => {
    process.stderr.write(`[heimdall-triage] Warning: could not save drift checkpoint: ${getMessage(err)}\n`);
  });

  if (!previous) {
    process.stderr.write(`[heimdall-triage] No previous checkpoint found — baseline saved for next run\n`);
    return '';
  }

  const findings = detectDrift(current, previous);
  if (findings.length > 0) {
    process.stderr.write(`[heimdall-triage] Drift detected: ${findings.length} change(s) since ${previous.timestamp}\n`);
  } else {
    process.stderr.write(`[heimdall-triage] No infrastructure drift detected since ${previous.timestamp}\n`);
  }
  return buildDriftPromptSection(findings, previous.timestamp);
}

/** Write a baseline entry for each critical/warning finding in the agent's output, when learning is enabled. */
async function recordBaselines(config: LoadedConfig, output: string): Promise<void> {
  if (config.learning?.enabled === false || !output) return;

  const configDir = dirname(resolve(process.env.HEIMDALL_CONFIG ?? 'heimdall.config.yaml'));
  const baselineFile = resolveBaselineFilePath(config.learning?.baselineFile, configDir);
  const clusterName = process.env.HEIMDALL_CLUSTER_NAME ?? 'default';
  const findings = parseTriageFindings(output);
  for (const finding of findings) {
    await upsertBaseline(clusterName, finding.namespace, finding.kind, finding.name, finding.summary, baselineFile).catch((err: unknown) => {
      process.stderr.write(`[heimdall-triage] Warning: could not write baseline: ${getMessage(err)}\n`);
    });
  }
  if (findings.length > 0) {
    process.stderr.write(`[heimdall-triage] Recorded ${findings.length} baseline entr${findings.length === 1 ? 'y' : 'ies'} for recurring-pattern tracking.\n`);
  }
}

export async function runTriageMode(opts: TriageOptions = {}, model?: string): Promise<void> {
  const config = loadConfig();
  // Only inject SLO step when prometheusQuery is enabled; the slo-evaluator
  // subagent has no Prometheus tool otherwise and cannot evaluate anything.
  const slos = config.tools.prometheusQuery ? (config.slos ?? []) : [];

  const driftSection = await performDriftDetection(config);
  const basePrompt = buildTriagePrompt({ ...opts, slos });
  const prompt = driftSection ? driftSection + basePrompt : basePrompt;

  for (const message of buildSweepStartupMessages(opts)) {
    process.stderr.write(`${message}\n`);
  }

  const output = await runAgent(prompt, model);
  await recordBaselines(config, output);
}

// --- CLI arg parsing when run directly ---
if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const opts: { namespace?: string; allNamespaces?: boolean; contexts?: string[] } = {};
  let modelFlag: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-n' || arg === '--namespace') {
      requireNextArg(args, i, `${arg} requires a namespace argument`);
      opts.namespace = args[++i];
    } else if (arg.startsWith('--namespace=')) {
      const ns = arg.slice('--namespace='.length);
      requireNonEmptyValue(ns, '--namespace= requires a non-empty value');
      opts.namespace = ns;
    } else if (arg === '-A' || arg === '--all-namespaces') {
      opts.allNamespaces = true;
    } else if (arg === '--contexts') {
      requireNextArg(args, i, '--contexts requires a comma-separated list of context names');
      opts.contexts = parseCommaSeparatedList(args[++i], '--contexts value produced an empty list after parsing');
    } else if (arg.startsWith('--contexts=')) {
      const raw = arg.slice('--contexts='.length);
      requireNonEmptyValue(raw, '--contexts= requires a non-empty comma-separated list');
      opts.contexts = parseCommaSeparatedList(raw, '--contexts= value produced an empty list after parsing');
    } else if (arg === '--model' || arg.startsWith('--model=')) {
      const parsed = parseModelFlag(args, i);
      modelFlag = parsed.value;
      i = parsed.nextIndex;
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(`Usage: heimdall triage [-n <namespace>] [-A] [--contexts <ctx1,ctx2,...>]

Run a structured whole-cluster health sweep and report findings by severity.

Options:
  -n, --namespace <ns>          Scope the sweep to a single namespace
  -A, --all-namespaces          Sweep all namespaces
  --contexts <ctx1,ctx2,...>    Sweep multiple kubeconfig contexts (multi-cluster mode)
  --model <provider/model>      Override the LLM model (default: anthropic/claude-sonnet-4-6)
  -h, --help                    Show this help message

Examples:
  heimdall triage                                     # sweep the default namespace
  heimdall triage -A                                  # sweep all namespaces
  heimdall triage -n prod                             # sweep only the prod namespace
  heimdall triage --contexts cluster-a,cluster-b      # multi-cluster sweep
  heimdall triage --contexts=prod-us,prod-eu -A       # multi-cluster, all namespaces
  npm run triage -- -n staging
`);
      process.exit(0);
    } else {
      process.stderr.write(`Error: unknown option: ${arg}\n`);
      process.exit(1);
    }
  }

  let resolvedModel: string;
  try {
    resolvedModel = resolveModel(modelFlag);
  } catch (err) {
    process.stderr.write(`Error: ${getMessage(err)}\n`);
    process.exit(1);
  }

  runTriageMode(opts, resolvedModel).catch((err: unknown) => {
    process.stderr.write(`[heimdall-triage] Fatal error: ${getStackOrMessage(err)}\n`);
    process.exit(1);
  });
}
