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
import { spawn } from 'node:child_process';
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

const TRIAGE_TIMEOUT_MS = 300_000; // 5 minutes — a full sweep needs time

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Invoke the Heimdall agent with a prompt.
 * Streams output to stdout (tee) and also returns the full captured text so
 * callers can parse findings for baseline writing.
 */
async function runAgent(prompt: string, model?: string): Promise<string> {
  const binPath = resolve(__dirname, '..', 'bin', 'heimdall');

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (err?: Error, output?: string) => {
      if (!settled) {
        settled = true;
        if (err) reject(err);
        else resolve(output ?? '');
      }
    };

    const env = model ? { ...process.env, HEIMDALL_MODEL: model } : process.env;
    const child = spawn(binPath, ['-p', prompt], {
      // pipe stdout so we can tee it to terminal and capture it for baseline parsing
      stdio: ['ignore', 'pipe', 'inherit'],
      env,
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(new Error('triage timed out after 5 minutes'));
    }, TRIAGE_TIMEOUT_MS);

    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      output += text;
    });

    child.on('close', (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      if (code !== null && code !== 0) {
        settle(new Error(`heimdall exited with code ${code}`));
      } else if (code === null && signal !== null) {
        settle(new Error(`heimdall killed by signal ${signal}`));
      } else {
        settle(undefined, output);
      }
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      settle(err);
    });
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

export async function runTriageMode(opts: TriageOptions = {}, model?: string): Promise<void> {
  const config = loadConfig();
  // Only inject SLO step when prometheusQuery is enabled; the slo-evaluator
  // subagent has no Prometheus tool otherwise and cannot evaluate anything.
  const slos = config.tools.prometheusQuery ? (config.slos ?? []) : [];

  // Drift detection: load previous checkpoint, capture current state, compute delta.
  let driftSection = '';
  const driftEnabled = config.drift?.enabled ?? false;
  const checkpointFile = config.drift?.checkpointFile ?? DEFAULT_CHECKPOINT_FILE;
  if (driftEnabled) {
    const now = new Date().toISOString();
    const lockedNamespace = config.namespace?.locked ?? undefined;
    const [previous, current] = await Promise.all([
      loadCheckpoint(checkpointFile).catch(() => null),
      captureCheckpoint(now, lockedNamespace),
    ]);
    if (current) {
      // Save the new checkpoint only when we got real data from the cluster.
      saveCheckpoint(current, checkpointFile).catch((err: unknown) => {
        process.stderr.write(`[heimdall-triage] Warning: could not save drift checkpoint: ${err instanceof Error ? err.message : String(err)}\n`);
      });
      const findings = detectDrift(current, previous);
      if (previous) {
        driftSection = buildDriftPromptSection(findings, previous.timestamp);
        if (findings.length > 0) {
          process.stderr.write(`[heimdall-triage] Drift detected: ${findings.length} change(s) since ${previous.timestamp}\n`);
        } else {
          process.stderr.write(`[heimdall-triage] No infrastructure drift detected since ${previous.timestamp}\n`);
        }
      } else {
        process.stderr.write(`[heimdall-triage] No previous checkpoint found — baseline saved for next run\n`);
      }
    } else {
      process.stderr.write(`[heimdall-triage] Drift snapshot skipped — kubectl unavailable or cluster unreachable\n`);
    }
  }

  const basePrompt = buildTriagePrompt({ ...opts, slos });
  const prompt = driftSection ? driftSection + basePrompt : basePrompt;

  if (opts.contexts && opts.contexts.length > 0) {
    process.stderr.write(`[heimdall-triage] Starting multi-cluster sweep across: ${opts.contexts.join(', ')}\n`);
    if (opts.namespace) {
      process.stderr.write(`[heimdall-triage] Scope: namespace "${opts.namespace}"\n`);
    } else if (opts.allNamespaces) {
      process.stderr.write('[heimdall-triage] Scope: all namespaces\n');
    }
  } else {
    process.stderr.write('[heimdall-triage] Starting cluster health sweep...\n');
    if (opts.namespace) {
      process.stderr.write(`[heimdall-triage] Scope: namespace "${opts.namespace}"\n`);
    } else if (opts.allNamespaces) {
      process.stderr.write('[heimdall-triage] Scope: all namespaces\n');
    }
  }

  const output = await runAgent(prompt, model);

  // Write baselines for critical and warning findings when learning is enabled.
  if (config.learning?.enabled !== false && output) {
    const configDir = dirname(resolve(process.env.HEIMDALL_CONFIG ?? 'heimdall.config.yaml'));
    const baselineFile = resolveBaselineFilePath(config.learning?.baselineFile, configDir);
    const clusterName = process.env.HEIMDALL_CLUSTER_NAME ?? 'default';
    const findings = parseTriageFindings(output);
    for (const finding of findings) {
      await upsertBaseline(clusterName, finding.namespace, finding.kind, finding.name, finding.summary, baselineFile).catch((err: unknown) => {
        process.stderr.write(`[heimdall-triage] Warning: could not write baseline: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    }
    if (findings.length > 0) {
      process.stderr.write(`[heimdall-triage] Recorded ${findings.length} baseline entr${findings.length === 1 ? 'y' : 'ies'} for recurring-pattern tracking.\n`);
    }
  }
}

// --- CLI arg parsing when run directly ---
const args = process.argv.slice(2);
const opts: { namespace?: string; allNamespaces?: boolean; contexts?: string[] } = {};
let modelFlag: string | undefined;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '-n' || arg === '--namespace') {
    if (!args[i + 1] || args[i + 1].startsWith('-')) {
      process.stderr.write(`Error: ${arg} requires a namespace argument\n`);
      process.exit(1);
    }
    opts.namespace = args[++i];
  } else if (arg.startsWith('--namespace=')) {
    const ns = arg.slice('--namespace='.length);
    if (!ns) {
      process.stderr.write(`Error: --namespace= requires a non-empty value\n`);
      process.exit(1);
    }
    opts.namespace = ns;
  } else if (arg === '-A' || arg === '--all-namespaces') {
    opts.allNamespaces = true;
  } else if (arg === '--contexts') {
    if (!args[i + 1] || args[i + 1].startsWith('-')) {
      process.stderr.write(`Error: --contexts requires a comma-separated list of context names\n`);
      process.exit(1);
    }
    const parsed = args[++i].split(',').map((c) => c.trim()).filter(Boolean);
    if (parsed.length === 0) {
      process.stderr.write(`Error: --contexts value produced an empty list after parsing\n`);
      process.exit(1);
    }
    opts.contexts = Array.from(new Set(parsed));
  } else if (arg.startsWith('--contexts=')) {
    const raw = arg.slice('--contexts='.length);
    if (!raw) {
      process.stderr.write(`Error: --contexts= requires a non-empty comma-separated list\n`);
      process.exit(1);
    }
    const parsed = raw.split(',').map((c) => c.trim()).filter(Boolean);
    if (parsed.length === 0) {
      process.stderr.write(`Error: --contexts= value produced an empty list after parsing\n`);
      process.exit(1);
    }
    opts.contexts = Array.from(new Set(parsed));
  } else if (arg === '--model') {
    if (!args[i + 1] || args[i + 1].startsWith('-')) {
      process.stderr.write(`Error: --model requires a value\n`);
      process.exit(1);
    }
    modelFlag = args[++i];
  } else if (arg.startsWith('--model=')) {
    const m = arg.slice('--model='.length);
    if (!m) {
      process.stderr.write(`Error: --model= requires a non-empty value\n`);
      process.exit(1);
    }
    modelFlag = m;
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
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

runTriageMode(opts, resolvedModel).catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[heimdall-triage] Fatal error: ${detail}\n`);
  process.exit(1);
});
