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
import { buildTriagePrompt } from './lib/triage.ts';

const TRIAGE_TIMEOUT_MS = 300_000; // 5 minutes — a full sweep needs time

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Invoke the Heimdall agent with a prompt, streaming output to stdout. */
async function runAgent(prompt: string): Promise<void> {
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

    const child = spawn(binPath, ['-p', prompt], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(new Error('triage timed out after 5 minutes'));
    }, TRIAGE_TIMEOUT_MS);

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code !== null && code !== 0) {
        settle(new Error(`heimdall exited with code ${code}`));
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

export async function runTriageMode(opts: {
  namespace?: string;
  allNamespaces?: boolean;
} = {}): Promise<void> {
  const prompt = buildTriagePrompt(opts);

  process.stderr.write('[heimdall-triage] Starting cluster health sweep...\n');
  if (opts.namespace) {
    process.stderr.write(`[heimdall-triage] Scope: namespace "${opts.namespace}"\n`);
  } else if (opts.allNamespaces) {
    process.stderr.write('[heimdall-triage] Scope: all namespaces\n');
  }

  await runAgent(prompt);
}

// --- CLI arg parsing when run directly ---
const args = process.argv.slice(2);
const opts: { namespace?: string; allNamespaces?: boolean } = {};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if ((arg === '-n' || arg === '--namespace') && args[i + 1]) {
    opts.namespace = args[++i];
  } else if (arg === '-A' || arg === '--all-namespaces') {
    opts.allNamespaces = true;
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`Usage: heimdall triage [-n <namespace>] [-A]

Run a structured whole-cluster health sweep and report findings by severity.

Options:
  -n, --namespace <ns>   Scope the sweep to a single namespace
  -A, --all-namespaces   Sweep all namespaces (default when no namespace given)
  -h, --help             Show this help message

Examples:
  heimdall triage                # sweep the default namespace
  heimdall triage -A             # sweep all namespaces
  heimdall triage -n prod        # sweep only the prod namespace
  npm run triage -- -n staging
`);
    process.exit(0);
  }
}

runTriageMode(opts).catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[heimdall-triage] Fatal error: ${detail}\n`);
  process.exit(1);
});
