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
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveConfigDir } from './lib/config.ts';
import type { HeimdallConfig } from './lib/config.ts';
import { upsertBaseline, resolveBaselineFilePath, truncateSummary } from './lib/baseline.ts';
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
import { resolveBinPath, buildAgentEnv } from './lib/bin-path.ts';
import { parseModelFlag, isMainModule, resolveModelOrExit, handleHelpOrUnknownOption } from './lib/cli-args.ts';
import { abortableSleep, installShutdownController } from './lib/abortable-sleep.ts';
import { spawnAndCollect } from './lib/spawn-collect.ts';

export const DIAGNOSIS_TIMEOUT_MS = 120_000;
const DIAGNOSIS_TIMEOUT_MESSAGE = 'diagnosis timed out';
// Backoff: 1 s → 2 s → 4 s … capped at 30 s, ±30 % jitter.
const BACKOFF_OPTS = { baseMs: 1_000, capMs: 30_000, jitter: 0.3 };
// Reset the reconnect counter after a stream that was healthy for ≥ 60 s.
const BACKOFF_RESET_THRESHOLD_MS = 60_000;

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Write a status line to stderr, tagged with the `[heimdall-watch]` prefix. */
function logWatch(msg: string): void {
  process.stderr.write(`[heimdall-watch] ${msg}\n`);
}

/** Invoke the Heimdall agent with a single prompt and return its response. */
export async function diagnoseEvent(prompt: string, model?: string): Promise<string> {
  const binPath = resolveBinPath(__dirname);

  try {
    // stdio: 'stdout' inherits stderr so the agent's diagnostic output is
    // visible on the watch-mode process's stderr alongside our own status
    // messages, while buffering stdout (silently — no live echo) to return.
    const stdout = await spawnAndCollect(binPath, ['-p', prompt], {
      env: buildAgentEnv(model),
      timeoutMs: DIAGNOSIS_TIMEOUT_MS,
      stdio: 'stdout',
      onTimeout: () => new Error(DIAGNOSIS_TIMEOUT_MESSAGE),
      onExit: () => null,
    });
    return stdout || '(no diagnosis)';
  } catch (err: unknown) {
    if (err instanceof Error && err.message === DIAGNOSIS_TIMEOUT_MESSAGE) {
      return '(diagnosis timed out)';
    }
    return `(diagnosis failed: ${getMessage(err)})`;
  }
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
export async function runWatchStream(
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
    logWatch(`kubectl exited with code ${code ?? 'null'}`);
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
      logWatch(`Cooldown: suppressing repeat ${event.reason} on ${objRef} in ${ns}`);
      continue;
    }

    logWatch(`Warning: ${event.reason} on ${objRef} in ${ns}`);

    const prompt = buildDiagnosticPrompt(event);
    const diagnosis = await diagnoseEvent(prompt, model);
    const finding = formatFinding(event, ts, diagnosis);

    process.stdout.write(JSON.stringify(finding) + '\n');

    // Write a baseline entry so recurring events are recognised in future runs.
    if (baselineFile) {
      const clusterName = process.env.HEIMDALL_CLUSTER_NAME ?? 'default';
      const summary = truncateSummary(`[${event.reason}] ${diagnosis}`);
      const { kind: baselineKind, name: baselineName } = eventObjectRef(event);
      try {
        await upsertBaseline(clusterName, ns, baselineKind, baselineName, summary, baselineFile);
      } catch (err: unknown) {
        logWatch(`Warning: could not write baseline: ${getMessage(err)}`);
      }
    }

    if (watchCfg?.webhook) {
      postWebhook(watchCfg.webhook, finding).catch((err: unknown) => {
        logWatch(`Webhook error: ${getMessage(err)}`);
      });
    }

    if (eventSink) {
      eventSink.write(finding).catch((err: unknown) => {
        logWatch(`EventSink error: ${getMessage(err)}`);
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
    ? resolveBaselineFilePath(config.learning?.baselineFile, resolveConfigDir())
    : null;

  // Watch a single namespace explicitly, or all namespaces (-A).
  const kubectlArgs =
    namespaces.length === 1
      ? ['get', 'events', '--watch', '-o', 'json', '-n', namespaces[0]]
      : ['get', 'events', '--watch', '-o', 'json', '-A'];

  logWatch('Starting Kubernetes Warning event monitor...');
  if (namespaces.length > 0) {
    logWatch(`Watching namespaces: ${namespaces.join(', ')}`);
  }
  if (watchCfg?.reasons?.length) {
    logWatch(`Filtering reasons: ${watchCfg.reasons.join(', ')}`);
  }
  logWatch(`Cooldown: ${cooldownSeconds}s per (object, reason)`);

  const eventSink = createEventSink(watchCfg?.eventSink);
  if (eventSink) {
    const sinkParts = [
      watchCfg?.eventSink?.filePath ? `file:${watchCfg.eventSink.filePath}` : null,
      watchCfg?.eventSink?.webhookUrl ? 'webhook' : null,
      watchCfg?.eventSink?.s3Bucket ? `s3:${watchCfg.eventSink.s3Bucket}` : null,
    ].filter(Boolean);
    logWatch(`EventSink enabled: ${sinkParts.join(', ')}`);
  }

  let attempt = 0;
  const { signal, cleanup } = installShutdownController();

  while (!signal.aborted) {
    const streamStartMs = Date.now();

    try {
      await runWatchStream(kubectlArgs, watchCfg, cooldownState, cooldownSeconds, signal, eventSink, baselineFile, model);
    } catch (err: unknown) {
      if (signal.aborted) break;
      logWatch(`Stream error: ${getMessage(err)}`);
    }

    if (signal.aborted) break;

    const uptimeMs = Date.now() - streamStartMs;
    if (shouldResetBackoff(uptimeMs, BACKOFF_RESET_THRESHOLD_MS)) {
      attempt = 0;
      logWatch('Stream was healthy; resetting reconnect counter.');
    }

    if (maxAttempts !== null && attempt >= maxAttempts) {
      logWatch(`Max reconnect attempts (${maxAttempts}) reached. Exiting.`);
      process.exit(1);
    }

    const delayMs = computeBackoffMs(attempt, BACKOFF_OPTS);
    logWatch(
      `Stream ended. Reconnecting in ${delayMs}ms` +
      ` (attempt ${attempt + 1}${maxAttempts !== null ? `/${maxAttempts}` : ''})...`,
    );

    await abortableSleep(delayMs, signal);

    attempt++;
  }

  logWatch('Shutting down cleanly.');
  cleanup();
}

const WATCH_HELP_TEXT = `Usage: heimdall --watch [--model <provider/model>]\n\nOptions:\n  --model <provider/model>  Override the LLM model\n  -h, --help                Show this help\n`;

export interface WatchCliArgs {
  modelFlag: string | undefined;
}

/**
 * Parse `heimdall --watch` CLI flags. Exits the process directly for
 * --help and unknown options, matching this mode's historical behavior.
 */
export function parseWatchArgv(argv: string[]): WatchCliArgs {
  let modelFlag: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--model' || arg.startsWith('--model=')) {
      const parsed = parseModelFlag(argv, i);
      modelFlag = parsed.value;
      i = parsed.nextIndex;
    } else {
      handleHelpOrUnknownOption(arg, WATCH_HELP_TEXT);
    }
  }

  return { modelFlag };
}

// --- CLI arg parsing when run directly ---
if (isMainModule(import.meta.url)) {
  const { modelFlag: watchModelFlag } = parseWatchArgv(process.argv.slice(2));

  const resolvedWatchModel = resolveModelOrExit(watchModelFlag);

  runWatchMode(resolvedWatchModel).catch((err: unknown) => {
    logWatch(`Fatal error: ${getStackOrMessage(err)}`);
    process.exit(1);
  });
}
