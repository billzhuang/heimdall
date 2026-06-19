/**
 * Heimdall proactive watch mode.
 *
 * Streams Kubernetes Warning events from the cluster and auto-diagnoses each
 * one by calling the Heimdall agent.  Findings are emitted as JSON lines to
 * stdout and optionally POSTed to a webhook.
 *
 * The kubectl watch stream is supervised: when it ends (network blip,
 * API-server restart, idle-timeout, etc.) the monitor reconnects with
 * exponential backoff + jitter.  On SIGINT/SIGTERM the loop exits cleanly
 * without a reconnect attempt.
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
 *     cooldownSeconds: 300                 # default 300 s; 0 = no cooldown
 *     maxReconnectAttempts: 10             # omit for unlimited retries
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.ts';
import type { HeimdallConfig } from './lib/config.ts';
import {
  parseEventLine,
  matchesWatchFilter,
  buildDiagnosticPrompt,
  formatFinding,
  postWebhook,
  shouldDiagnose,
  computeBackoffMs,
  shouldResetBackoff,
  type CooldownState,
} from './lib/watch.ts';

const DIAGNOSIS_TIMEOUT_MS = 120_000;
// Backoff: 1 s → 2 s → 4 s … capped at 30 s, ±30 % jitter.
const BACKOFF_OPTS = { baseMs: 1_000, capMs: 30_000, jitter: 0.3 };
// Reset the reconnect counter after a stream that was healthy for ≥ 60 s.
const BACKOFF_RESET_THRESHOLD_MS = 60_000;

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Invoke the Heimdall agent with a single prompt and return its response. */
async function diagnoseEvent(prompt: string): Promise<string> {
  const binPath = resolve(__dirname, '..', 'bin', 'heimdall');

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: string) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const child = spawn(binPath, ['-p', prompt], {
      // stderr is inherited so the agent's diagnostic output is visible on the
      // watch-mode process's stderr alongside our own status messages.  Using
      // 'pipe' without draining would risk a buffer deadlock if the agent
      // writes a lot of diagnostic text.
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle('(diagnosis timed out)');
    }, DIAGNOSIS_TIMEOUT_MS);

    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on('close', () => {
      clearTimeout(timer);
      settle(output.trim() || '(no diagnosis)');
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      settle(`(diagnosis failed: ${err.message})`);
    });
  });
}

/**
 * Run one kubectl watch session until the stream ends.
 *
 * Processes each Warning event: filters, applies cooldown, diagnoses, and
 * emits a JSON finding line.  Returns normally when the stream closes.
 * Throws when kubectl fails to start.
 * Returns early (without throwing) when `isShuttingDown()` becomes true.
 *
 * @param onAbortReady - called once readline is ready with a function that
 *   closes the readline and kills kubectl.  The outer loop uses this to
 *   unblock the for-await immediately on SIGINT/SIGTERM rather than waiting
 *   for the next event line (which may never arrive on an idle cluster).
 */
async function runWatchStream(
  kubectlArgs: string[],
  watchCfg: HeimdallConfig['watch'],
  cooldownState: CooldownState,
  cooldownSeconds: number,
  isShuttingDown: () => boolean,
  onAbortReady: (abort: () => void) => void,
): Promise<void> {
  const kubectl = spawn('kubectl', kubectlArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let spawnError: Error | null = null;

  kubectl.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[kubectl] ${chunk.toString()}`);
  });

  kubectl.on('close', (code: number | null) => {
    process.stderr.write(`[heimdall-watch] kubectl exited with code ${code ?? 'null'}\n`);
  });

  if (!kubectl.stdout) {
    throw new Error('kubectl stdout unavailable');
  }

  const rl = createInterface({ input: kubectl.stdout, crlfDelay: Infinity });

  // Expose an abort handle so the outer loop can close this stream immediately
  // on SIGINT/SIGTERM without waiting for the next event line.
  onAbortReady(() => {
    rl.close();
    kubectl.kill('SIGTERM');
  });

  // Close readline when kubectl fails to start so the for-await loop exits.
  kubectl.on('error', (err: Error) => {
    spawnError = err;
    rl.close();
  });

  // Process events serially: one diagnosis at a time keeps memory bounded and
  // avoids hammering the API server during burst events.
  for await (const line of rl) {
    if (isShuttingDown()) {
      rl.close();
      kubectl.kill('SIGTERM');
      return;
    }

    const event = parseEventLine(line);
    if (!event) continue;
    if (!matchesWatchFilter(event, watchCfg ?? {})) continue;

    const ts = new Date().toISOString();
    const ns = event.metadata.namespace ?? event.involvedObject.namespace ?? 'unknown';
    const objRef = `${event.involvedObject.kind ?? 'unknown'}/${event.involvedObject.name ?? 'unknown'}`;

    if (!shouldDiagnose(event, cooldownState, Date.now(), cooldownSeconds)) {
      process.stderr.write(
        `[heimdall-watch] Cooldown: suppressing repeat ${event.reason} on ${objRef} in ${ns}\n`,
      );
      continue;
    }

    process.stderr.write(
      `[heimdall-watch] Warning: ${event.reason} on ${objRef} in ${ns}\n`,
    );

    const prompt = buildDiagnosticPrompt(event);
    const diagnosis = await diagnoseEvent(prompt);
    const finding = formatFinding(event, ts, diagnosis);

    process.stdout.write(JSON.stringify(finding) + '\n');

    if (watchCfg?.webhook) {
      postWebhook(watchCfg.webhook, finding).catch((err: unknown) => {
        process.stderr.write(`[heimdall-watch] Webhook error: ${String(err)}\n`);
      });
    }
  }

  if (spawnError) throw spawnError;
}

export async function runWatchMode(): Promise<void> {
  const config = loadConfig();
  const watchCfg = config.watch;
  const namespaces = watchCfg?.namespaces ?? [];
  const cooldownSeconds = watchCfg?.cooldownSeconds ?? 300;
  const maxAttempts = watchCfg?.maxReconnectAttempts ?? null;
  const cooldownState: CooldownState = new Map();

  // Watch a single namespace explicitly, or all namespaces (-A).
  const kubectlArgs =
    namespaces.length === 1
      ? ['get', 'events', '--watch', '-o', 'json', '-n', namespaces[0]]
      : ['get', 'events', '--watch', '-o', 'json', '-A'];

  process.stderr.write('[heimdall-watch] Starting Kubernetes Warning event monitor...\n');
  if (namespaces.length > 0) {
    process.stderr.write(`[heimdall-watch] Watching namespaces: ${namespaces.join(', ')}\n`);
  }
  if (watchCfg?.reasons?.length) {
    process.stderr.write(`[heimdall-watch] Filtering reasons: ${watchCfg.reasons.join(', ')}\n`);
  }
  process.stderr.write(`[heimdall-watch] Cooldown: ${cooldownSeconds}s per (object, reason)\n`);

  let attempt = 0;
  let shuttingDown = false;
  let activeAbort: (() => void) | null = null;

  const onSignal = () => {
    shuttingDown = true;
    activeAbort?.(); // immediately unblock the readline for-await loop
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  while (true) {
    const streamStartMs = Date.now();
    activeAbort = null;

    try {
      await runWatchStream(
        kubectlArgs, watchCfg, cooldownState, cooldownSeconds,
        () => shuttingDown,
        (abort) => { activeAbort = abort; },
      );
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[heimdall-watch] Stream error: ${detail}\n`);
    }

    if (shuttingDown) {
      process.stderr.write('[heimdall-watch] Shutting down cleanly.\n');
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      return;
    }

    const uptimeMs = Date.now() - streamStartMs;
    if (shouldResetBackoff(uptimeMs, BACKOFF_RESET_THRESHOLD_MS)) {
      attempt = 0;
      process.stderr.write('[heimdall-watch] Stream was healthy; resetting reconnect counter.\n');
    }

    if (maxAttempts !== null && attempt >= maxAttempts) {
      process.stderr.write(`[heimdall-watch] Max reconnect attempts (${maxAttempts}) reached. Exiting.\n`);
      process.exit(1);
    }

    const delayMs = computeBackoffMs(attempt, BACKOFF_OPTS);
    process.stderr.write(
      `[heimdall-watch] Stream ended. Reconnecting in ${delayMs}ms` +
      ` (attempt ${attempt + 1}${maxAttempts !== null ? `/${maxAttempts}` : ''})...\n`,
    );
    await new Promise<void>(r => setTimeout(r, delayMs));
    attempt++;
  }
}

runWatchMode().catch((err: unknown) => {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`[heimdall-watch] Fatal error: ${detail}\n`);
  process.exit(1);
});
