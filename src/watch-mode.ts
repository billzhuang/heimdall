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
import { upsertBaseline, resolveBaselineFilePath, inferDiagnosisSeverity, truncateSummary } from './lib/baseline.ts';
import { resolveModel } from './lib/model.ts';
import {
  parseEventLine,
  matchesWatchFilter,
  buildDiagnosticPrompt,
  formatFinding,
  postWebhook,
  shouldDiagnose,
  computeBackoffMs,
  shouldResetBackoff,
  eventObjectRef,
  type CooldownState,
} from './lib/watch.ts';
import { createEventSink, type EventSink } from './lib/event-sink.ts';
import { getMessage, getStackOrMessage } from './lib/error-utils.ts';
import { resolveBinPath } from './lib/bin-path.ts';
import { parseModelFlag } from './lib/cli-args.ts';
import { abortableSleep, installShutdownController } from './lib/abortable-sleep.ts';

const DIAGNOSIS_TIMEOUT_MS = 120_000;
// Backoff: 1 s → 2 s → 4 s … capped at 30 s, ±30 % jitter.
const BACKOFF_OPTS = { baseMs: 1_000, capMs: 30_000, jitter: 0.3 };
// Reset the reconnect counter after a stream that was healthy for ≥ 60 s.
const BACKOFF_RESET_THRESHOLD_MS = 60_000;

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Invoke the Heimdall agent with a single prompt and return its response. */
async function diagnoseEvent(prompt: string, model?: string): Promise<string> {
  const binPath = resolveBinPath(__dirname);

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: string) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const env = model ? { ...process.env, HEIMDALL_MODEL: model } : process.env;
    const child = spawn(binPath, ['-p', prompt], {
      // stderr is inherited so the agent's diagnostic output is visible on the
      // watch-mode process's stderr alongside our own status messages.  Using
      // 'pipe' without draining would risk a buffer deadlock if the agent
      // writes a lot of diagnostic text.
      stdio: ['ignore', 'pipe', 'inherit'],
      env,
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
 *
 * Aborting `signal` immediately closes the readline interface and kills
 * kubectl, unblocking the for-await loop even when no events are arriving.
 */
async function runWatchStream(
  kubectlArgs: string[],
  watchCfg: HeimdallConfig['watch'],
  cooldownState: CooldownState,
  cooldownSeconds: number,
  signal: AbortSignal,
  eventSink: EventSink | null,
  baselineFile: string | null,
  model?: string,
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

  // Abort handler: close readline and kill kubectl immediately so the
  // for-await loop unblocks even when the cluster is idle.
  const onAbort = () => {
    rl.close();
    kubectl.kill('SIGTERM');
  };
  signal.addEventListener('abort', onAbort, { once: true });

  // Close readline when kubectl fails to start so the for-await loop exits.
  kubectl.on('error', (err: Error) => {
    spawnError = err;
    rl.close();
  });

  // Process events serially: one diagnosis at a time keeps memory bounded and
  // avoids hammering the API server during burst events.
  for await (const line of rl) {
    if (signal.aborted) return;

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
    const diagnosis = await diagnoseEvent(prompt, model);
    const finding = formatFinding(event, ts, diagnosis);

    process.stdout.write(JSON.stringify(finding) + '\n');

    // Write a baseline entry so recurring events are recognised in future runs.
    if (baselineFile) {
      const clusterName = process.env.HEIMDALL_CLUSTER_NAME ?? 'default';
      const severity = inferDiagnosisSeverity(diagnosis);
      const summary = truncateSummary(`[${event.reason}] ${diagnosis}`);
      const { kind: baselineKind, name: baselineName } = eventObjectRef(event);
      try {
        await upsertBaseline(clusterName, ns, baselineKind, baselineName, summary, baselineFile);
      } catch (err: unknown) {
        process.stderr.write(`[heimdall-watch] Warning: could not write baseline: ${getMessage(err)}\n`);
      }
      void severity; // severity captured for future filtering; currently all watch events are recorded
    }

    if (watchCfg?.webhook) {
      postWebhook(watchCfg.webhook, finding).catch((err: unknown) => {
        process.stderr.write(`[heimdall-watch] Webhook error: ${String(err)}\n`);
      });
    }

    if (eventSink) {
      eventSink.write(finding).catch((err: unknown) => {
        process.stderr.write(`[heimdall-watch] EventSink error: ${String(err)}\n`);
      });
    }
  }

  signal.removeEventListener('abort', onAbort);
  if (spawnError) throw spawnError;
}

export async function runWatchMode(model?: string): Promise<void> {
  const config = loadConfig();
  const watchCfg = config.watch;
  const namespaces = watchCfg?.namespaces ?? [];
  const cooldownSeconds = watchCfg?.cooldownSeconds ?? 300;
  const maxAttempts = watchCfg?.maxReconnectAttempts ?? null;
  const cooldownState: CooldownState = new Map();

  const baselineFile = config.learning?.enabled !== false
    ? (() => {
        const configDir = dirname(resolve(process.env.HEIMDALL_CONFIG ?? 'heimdall.config.yaml'));
        return resolveBaselineFilePath(config.learning?.baselineFile, configDir);
      })()
    : null;

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

  const eventSink = createEventSink(watchCfg?.eventSink);
  if (eventSink) {
    const sinkParts = [
      watchCfg?.eventSink?.filePath ? `file:${watchCfg.eventSink.filePath}` : null,
      watchCfg?.eventSink?.webhookUrl ? 'webhook' : null,
      watchCfg?.eventSink?.s3Bucket ? `s3:${watchCfg.eventSink.s3Bucket}` : null,
    ].filter(Boolean);
    process.stderr.write(`[heimdall-watch] EventSink enabled: ${sinkParts.join(', ')}\n`);
  }

  let attempt = 0;
  const { signal, cleanup } = installShutdownController();

  while (!signal.aborted) {
    const streamStartMs = Date.now();

    try {
      await runWatchStream(kubectlArgs, watchCfg, cooldownState, cooldownSeconds, signal, eventSink, baselineFile, model);
    } catch (err: unknown) {
      if (signal.aborted) break;
      process.stderr.write(`[heimdall-watch] Stream error: ${getMessage(err)}\n`);
    }

    if (signal.aborted) break;

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

    await abortableSleep(delayMs, signal);

    attempt++;
  }

  process.stderr.write('[heimdall-watch] Shutting down cleanly.\n');
  cleanup();
}

// --- CLI arg parsing when run directly ---
const watchArgs = process.argv.slice(2);
let watchModelFlag: string | undefined;

for (let i = 0; i < watchArgs.length; i++) {
  const arg = watchArgs[i];
  if (arg === '--model' || arg.startsWith('--model=')) {
    const parsed = parseModelFlag(watchArgs, i);
    watchModelFlag = parsed.value;
    i = parsed.nextIndex;
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`Usage: heimdall --watch [--model <provider/model>]\n\nOptions:\n  --model <provider/model>  Override the LLM model\n  -h, --help                Show this help\n`);
    process.exit(0);
  } else {
    process.stderr.write(`Error: unknown option: ${arg}\n`);
    process.exit(1);
  }
}

let resolvedWatchModel: string;
try {
  resolvedWatchModel = resolveModel(watchModelFlag);
} catch (err) {
  process.stderr.write(`Error: ${getMessage(err)}\n`);
  process.exit(1);
}

runWatchMode(resolvedWatchModel).catch((err: unknown) => {
  process.stderr.write(`[heimdall-watch] Fatal error: ${getStackOrMessage(err)}\n`);
  process.exit(1);
});
