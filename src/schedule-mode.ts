/**
 * Heimdall schedule mode.
 *
 * A long-running process that periodically invokes Heimdall operations on
 * a cron schedule defined in `heimdall.config.yaml`.  Currently supports
 * scheduled triage sweeps; more scheduled tasks can be added.
 *
 * Usage:
 *   npm run schedule
 *   heimdall schedule [--once]
 *
 * The `--once` flag fires once immediately and exits — useful for CI or
 * one-off scheduled invocations (e.g. from a Kubernetes CronJob).
 *
 * Config (heimdall.config.yaml):
 *   schedule:
 *     triage:
 *       enabled: true
 *       cron: "0 *\/6 * * *"   # UTC cron: minute hour dom month dow
 *       namespace: prod          # optional; omit for default namespace
 *       allNamespaces: false     # set true to sweep all namespaces (-A)
 *
 * For external scheduling (Kubernetes CronJob, Render cron, etc.):
 *   Use `flue run triage --target node` instead of this process.
 *   See src/workflows/triage.ts.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type HeimdallConfig } from './lib/config.ts';
import { nextFireTime, validateCronExpression } from './lib/schedule.ts';
import { formatDurationMs } from './lib/duration.ts';
import { buildTriagePrompt, resolveNamespaceScope, type TriageOptions } from './lib/triage.ts';
import { getMessage, getStackOrMessage } from './lib/error-utils.ts';
import { resolveBinPath } from './lib/bin-path.ts';
import { interpretChildExit } from './lib/child-exit.ts';
import { spawnAndCollect } from './lib/spawn-collect.ts';
import { abortableSleep, installShutdownController } from './lib/abortable-sleep.ts';
import { die, isMainModule } from './lib/cli-args.ts';

const TRIAGE_TIMEOUT_MS = 300_000; // 5 minutes
const SIGKILL_GRACE_MS = 10_000;   // escalate to SIGKILL if child ignores SIGTERM

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Invoke the Heimdall agent with a prompt, streaming output to stdout. */
export async function runAgent(prompt: string, signal?: AbortSignal): Promise<void> {
  const binPath = resolveBinPath(__dirname);
  await spawnAndCollect(binPath, ['-p', prompt], {
    env: process.env,
    timeoutMs: TRIAGE_TIMEOUT_MS,
    killGraceMs: SIGKILL_GRACE_MS,
    stdio: 'inherit',
    signal,
    onTimeout: () => new Error('triage timed out after 5 minutes'),
    onAbort: () => new Error('Aborted'),
    onExit: (code, signalName) => interpretChildExit(code, signalName),
  });
}

/** Run one triage sweep. Returns true on success, false on failure. */
async function runTriage(opts: TriageOptions, signal?: AbortSignal): Promise<boolean> {
  const { scopeLabel: scope } = resolveNamespaceScope(opts);
  process.stderr.write(`[heimdall-schedule] Running scheduled triage (scope: ${scope})...\n`);

  try {
    await runAgent(buildTriagePrompt(opts), signal);
    process.stderr.write('[heimdall-schedule] Triage complete.\n');
    return true;
  } catch (err: unknown) {
    process.stderr.write(`[heimdall-schedule] Triage failed: ${getMessage(err)}\n`);
    return false;
  }
}

/** Resolution of the triage schedule read from heimdall.config.yaml. */
export type ScheduleResolution =
  | { ok: true; cron: string; triageOpts: TriageOptions }
  | { ok: false; reason: 'disabled' }
  | { ok: false; reason: 'invalid-cron'; cron: string; error: string };

/**
 * Pure resolution of the triage cron schedule from config: whether it's
 * enabled, and if so, the validated cron expression and triage options.
 * Kept separate from runScheduleMode so it can be unit-tested without
 * mocking process.exit/stderr.
 */
export function resolveTriageSchedule(config: HeimdallConfig): ScheduleResolution {
  const triageCfg = config.schedule?.triage;
  if (!triageCfg?.enabled) {
    return { ok: false, reason: 'disabled' };
  }

  const cron = triageCfg.cron ?? '0 */6 * * *';
  const cronError = validateCronExpression(cron);
  if (cronError) {
    return { ok: false, reason: 'invalid-cron', cron, error: cronError };
  }

  // namespace takes precedence over allNamespaces (matches resolveNamespaceScope contract).
  return {
    ok: true,
    cron,
    triageOpts: {
      namespace: triageCfg.namespace ?? undefined,
      allNamespaces: triageCfg.allNamespaces ?? false,
    },
  };
}

/**
 * Main entry point for schedule mode.
 *
 * Reads the cron schedule from heimdall.config.yaml and runs triage sweeps on
 * that cadence.  When `runOnce` is true, fires one sweep immediately and
 * exits (non-zero on failure); otherwise runs until SIGINT/SIGTERM.
 */
export async function runScheduleMode(runOnce = false): Promise<void> {
  const config = loadConfig();
  const resolution = resolveTriageSchedule(config);

  if (!resolution.ok) {
    if (resolution.reason === 'disabled') {
      process.stderr.write('[heimdall-schedule] No schedule is enabled in heimdall.config.yaml.\n');
      process.stderr.write('[heimdall-schedule] Add schedule.triage.enabled: true to enable.\n');
      if (!runOnce) process.exit(0);
      return;
    }
    process.stderr.write(`[heimdall-schedule] Invalid cron expression "${resolution.cron}": ${resolution.error}\n`);
    process.exit(1);
    return;
  }

  const { cron, triageOpts } = resolution;

  process.stderr.write(`[heimdall-schedule] Schedule mode started. Triage cron: "${cron}" (UTC)\n`);

  if (runOnce) {
    const ok = await runTriage(triageOpts);
    if (!ok) process.exit(1);
    return;
  }

  const { signal, cleanup } = installShutdownController();

  while (!signal.aborted) {
    const now = new Date();
    const nextFire = nextFireTime(cron, now);
    const delayMs = nextFire.getTime() - Date.now();

    process.stderr.write(
      `[heimdall-schedule] Next triage at ${nextFire.toISOString()} (in ${formatDurationMs(delayMs)})\n`,
    );

    await abortableSleep(delayMs, signal);
    if (signal.aborted) break;

    await runTriage(triageOpts, signal);
  }

  process.stderr.write('[heimdall-schedule] Shutting down cleanly.\n');
  cleanup();
}

const SCHEDULE_HELP_TEXT = `Usage: heimdall schedule [--once]

Run Heimdall operations on a cron schedule defined in heimdall.config.yaml.

Options:
  --once   Fire immediately once and exit (useful for CronJob containers)
  -h, --help   Show this help message

Config (heimdall.config.yaml):
  schedule:
    triage:
      enabled: true
      cron: "0 */6 * * *"   # standard 5-field UTC cron (minute hour dom month dow)
      namespace: prod         # optional namespace scope
      allNamespaces: false    # set true for -A sweep

Examples:
  npm run schedule              # long-running cron loop
  npm run schedule -- --once    # one-shot, exit when done
  heimdall schedule --once      # same via the bin CLI
  flue run triage --target node # run triage as a Flue workflow (for external schedulers)
`;

export interface ScheduleCliArgs {
  runOnce: boolean;
}

/**
 * Parse `heimdall schedule` CLI flags. Exits the process directly for
 * --help and unknown options, matching this mode's historical behavior.
 */
export function parseScheduleArgv(argv: string[]): ScheduleCliArgs {
  let runOnce = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--once') {
      runOnce = true;
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(SCHEDULE_HELP_TEXT);
      process.exit(0);
    } else {
      die(`unknown option: ${arg}`);
    }
  }

  return { runOnce };
}

// --- CLI arg parsing when run directly ---
if (isMainModule(import.meta.url)) {
  const { runOnce } = parseScheduleArgv(process.argv.slice(2));

  runScheduleMode(runOnce).catch((err: unknown) => {
    process.stderr.write(`[heimdall-schedule] Fatal error: ${getStackOrMessage(err)}\n`);
    process.exit(1);
  });
}
