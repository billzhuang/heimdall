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
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.ts';
import { nextFireTime, formatDelay, validateCronExpression } from './lib/schedule.ts';
import { buildTriagePrompt, resolveNamespaceScope, type TriageOptions } from './lib/triage.ts';
import { getMessage, getStackOrMessage } from './lib/error-utils.ts';
import { resolveBinPath } from './lib/bin-path.ts';
import { interpretChildExit } from './lib/child-exit.ts';
import { abortableSleep, installShutdownController } from './lib/abortable-sleep.ts';
import { isMainModule } from './lib/cli-args.ts';

const TRIAGE_TIMEOUT_MS = 300_000; // 5 minutes
const SIGKILL_GRACE_MS = 10_000;   // escalate to SIGKILL if child ignores SIGTERM

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Invoke the Heimdall agent with a prompt, streaming output to stdout. */
async function runAgent(prompt: string, signal?: AbortSignal): Promise<void> {
  const binPath = resolveBinPath(__dirname);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

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

    let timedOut = false;
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Escalate to SIGKILL if the child doesn't exit after SIGTERM.
      killTimer = setTimeout(() => child.kill('SIGKILL'), SIGKILL_GRACE_MS);
    }, TRIAGE_TIMEOUT_MS);

    const onAbort = () => {
      aborted = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), SIGKILL_GRACE_MS);
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('close', (code: number | null, signalName: string | null) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      if (aborted) {
        settle(new Error('Aborted'));
      } else if (timedOut) {
        settle(new Error('triage timed out after 5 minutes'));
      } else {
        settle(interpretChildExit(code, signalName) ?? undefined);
      }
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      settle(err);
    });
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

/**
 * Main entry point for schedule mode.
 *
 * Reads the cron schedule from heimdall.config.yaml and runs triage sweeps on
 * that cadence.  When `runOnce` is true, fires one sweep immediately and
 * exits (non-zero on failure); otherwise runs until SIGINT/SIGTERM.
 */
export async function runScheduleMode(runOnce = false): Promise<void> {
  const config = loadConfig();
  const scheduleCfg = config.schedule;
  const triageCfg = scheduleCfg?.triage;

  if (!triageCfg?.enabled) {
    process.stderr.write('[heimdall-schedule] No schedule is enabled in heimdall.config.yaml.\n');
    process.stderr.write('[heimdall-schedule] Add schedule.triage.enabled: true to enable.\n');
    if (!runOnce) process.exit(0);
    return;
  }

  const cron = triageCfg.cron ?? '0 */6 * * *';
  const cronError = validateCronExpression(cron);
  if (cronError) {
    process.stderr.write(`[heimdall-schedule] Invalid cron expression "${cron}": ${cronError}\n`);
    process.exit(1);
  }

  // namespace takes precedence over allNamespaces (matches resolveNamespaceScope contract).
  const triageOpts: TriageOptions = {
    namespace: triageCfg.namespace ?? undefined,
    allNamespaces: triageCfg.allNamespaces ?? false,
  };

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
      `[heimdall-schedule] Next triage at ${nextFire.toISOString()} (in ${formatDelay(delayMs)})\n`,
    );

    await abortableSleep(delayMs, signal);
    if (signal.aborted) break;

    await runTriage(triageOpts, signal);
  }

  process.stderr.write('[heimdall-schedule] Shutting down cleanly.\n');
  cleanup();
}

// --- CLI arg parsing when run directly ---
if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  let runOnce = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--once') {
      runOnce = true;
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(`Usage: heimdall schedule [--once]

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
`);
      process.exit(0);
    } else {
      process.stderr.write(`Error: unknown option: ${arg}\n`);
      process.exit(1);
    }
  }

  runScheduleMode(runOnce).catch((err: unknown) => {
    process.stderr.write(`[heimdall-schedule] Fatal error: ${getStackOrMessage(err)}\n`);
    process.exit(1);
  });
}
