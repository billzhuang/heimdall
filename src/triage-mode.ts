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

/** Invoke the Heimdall agent with a prompt, streaming output to stdout. */
async function runAgent(prompt: string, model?: string): Promise<void> {
  const binPath = resolve(__dirname, '..', 'bin', 'heimdall');

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (err?: Error) => {
      if (!settled) {
        settled = true;
        if (err) reject(err);
        else resolve();
      }
    };

    const env = model ? { ...process.env, HEIMDALL_MODEL: model } : process.env;
    const child = spawn(binPath, ['-p', prompt], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env,
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(new Error('triage timed out after 5 minutes'));
    }, TRIAGE_TIMEOUT_MS);

    child.on('close', (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      if (code !== null && code !== 0) {
        settle(new Error(`heimdall exited with code ${code}`));
      } else if (code === null && signal !== null) {
        settle(new Error(`heimdall killed by signal ${signal}`));
      } else {
        settle();
      }
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      settle(err);
    });
  });
}

const DEFAULT_CHECKPOINT_FILE = 'scenarios/drift-checkpoint.jsonl';

/**
 * Capture a lightweight cluster snapshot using direct kubectl reads.
 * Errors are swallowed — a missing kubectl or unreachable cluster must not
 * prevent the triage sweep itself from running.
 */
async function captureCheckpoint(timestamp: string): Promise<ClusterCheckpoint> {
  const [nsRaw, wlRaw, nodeRaw] = await Promise.all([
    runKubectl('get namespaces -o json').catch(() => ''),
    runKubectl('get deployments,statefulsets,daemonsets -A -o json').catch(() => ''),
    runKubectl('get nodes -o json').catch(() => ''),
  ]);
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
    const [previous, current] = await Promise.all([
      loadCheckpoint(checkpointFile).catch(() => null),
      captureCheckpoint(now),
    ]);
    // Save the new checkpoint regardless of whether a previous one existed.
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

  await runAgent(prompt, model);
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
