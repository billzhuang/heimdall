/**
 * Heimdall proactive watch mode.
 *
 * Streams Kubernetes Warning events from the cluster and auto-diagnoses each
 * one by calling the Heimdall agent.  Findings are emitted as JSON lines to
 * stdout and optionally POSTed to a webhook.
 *
 * Usage:
 *   npm run watch
 *   heimdall --watch
 *
 * Config (heimdall.config.yaml):
 *   watch:
 *     namespaces: ["prod", "staging"]  # omit for all namespaces
 *     webhook: https://hooks.slack.com/...  # optional Slack / generic webhook
 *     reasons: ["BackOff", "OOMKilled"]    # omit for all Warning events
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.ts';
import {
  parseEventLine,
  matchesWatchFilter,
  buildDiagnosticPrompt,
  formatFinding,
  postWebhook,
} from './lib/watch.ts';

const DIAGNOSIS_TIMEOUT_MS = 120_000;

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Invoke the Heimdall agent with a single prompt and return its response. */
async function diagnoseEvent(prompt: string): Promise<string> {
  const binPath = resolve(__dirname, '..', 'bin', 'heimdall');

  return new Promise((resolve) => {
    const child = spawn(binPath, ['-p', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, DIAGNOSIS_TIMEOUT_MS);

    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on('close', () => {
      clearTimeout(timer);
      resolve(output.trim() || '(no diagnosis)');
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve(`(diagnosis failed: ${err.message})`);
    });
  });
}

export async function runWatchMode(): Promise<void> {
  const config = loadConfig();
  const watchConfig = config.watch ?? {};
  const namespaces = watchConfig.namespaces ?? [];

  // Watch a single namespace explicitly, or all namespaces (-A).
  const kubectlArgs =
    namespaces.length === 1
      ? ['get', 'events', '--watch', '-o', 'json', '-n', namespaces[0]]
      : ['get', 'events', '--watch', '-o', 'json', '-A'];

  process.stderr.write('[heimdall-watch] Starting Kubernetes Warning event monitor...\n');
  if (namespaces.length > 0) {
    process.stderr.write(`[heimdall-watch] Watching namespaces: ${namespaces.join(', ')}\n`);
  }
  if (watchConfig.reasons?.length) {
    process.stderr.write(`[heimdall-watch] Filtering reasons: ${watchConfig.reasons.join(', ')}\n`);
  }

  const kubectl = spawn('kubectl', kubectlArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  kubectl.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[kubectl] ${chunk.toString()}`);
  });

  kubectl.on('error', (err: Error) => {
    process.stderr.write(`[heimdall-watch] Failed to start kubectl: ${err.message}\n`);
    process.exit(1);
  });

  kubectl.on('close', (code: number | null) => {
    process.stderr.write(
      `[heimdall-watch] kubectl exited with code ${code ?? 'null'}\n`,
    );
    if (code !== null && code !== 0) process.exit(code);
  });

  if (!kubectl.stdout) {
    process.stderr.write('[heimdall-watch] kubectl stdout unavailable\n');
    process.exit(1);
  }

  const rl = createInterface({ input: kubectl.stdout, crlfDelay: Infinity });

  // Process events serially: one diagnosis at a time keeps memory bounded and
  // avoids hammering the API server during burst events.
  for await (const line of rl) {
    const event = parseEventLine(line);
    if (!event) continue;
    if (!matchesWatchFilter(event, watchConfig)) continue;

    const ts = new Date().toISOString();
    const ns = event.metadata.namespace ?? event.involvedObject.namespace ?? 'unknown';
    const objRef = `${event.involvedObject.kind ?? 'unknown'}/${event.involvedObject.name ?? 'unknown'}`;
    process.stderr.write(
      `[heimdall-watch] Warning: ${event.reason} on ${objRef} in ${ns}\n`,
    );

    const prompt = buildDiagnosticPrompt(event);
    const diagnosis = await diagnoseEvent(prompt);
    const finding = formatFinding(event, ts, diagnosis);

    process.stdout.write(JSON.stringify(finding) + '\n');

    if (watchConfig.webhook) {
      postWebhook(watchConfig.webhook, finding).catch((err: unknown) => {
        process.stderr.write(`[heimdall-watch] Webhook error: ${String(err)}\n`);
      });
    }
  }
}

runWatchMode().catch((err: unknown) => {
  process.stderr.write(`[heimdall-watch] Fatal error: ${String(err)}\n`);
  process.exit(1);
});
