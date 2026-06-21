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
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.ts';
import { nextFireTime, formatDelay, validateCronExpression } from './lib/schedule.ts';
import { buildTriagePrompt, type TriageOptions } from './lib/triage.ts';

const TRIAGE_TIMEOUT_MS = 300_000; // 5 minutes

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

/** Run one triage sweep and return when complete. */
async function runTriage(opts: TriageOptions): Promise<void> {
  const scope = opts.namespace
    ? `namespace "${opts.namespace}"`
    : opts.allNamespaces
      ? 'all namespaces'
      : 'default namespace';
  process.stderr.write(`[heimdall-schedule] Running scheduled triage (scope: ${scope})...\n`);

  try {
    await runAgent(buildTriagePrompt(opts));
    process.stderr.write('[heimdall-schedule] Triage complete.\n');
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[heimdall-schedule] Triage failed: ${detail}\n`);
  }
}

/** Interruptible sleep that resolves early when the abort signal fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

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

  const triageOpts: TriageOptions = {
    namespace: triageCfg.namespace ?? undefined,
    allNamespaces: triageCfg.allNamespaces ?? false,
  };

  process.stderr.write(`[heimdall-schedule] Schedule mode started. Triage cron: "${cron}" (UTC)\n`);

  if (runOnce) {
    await runTriage(triageOpts);
    return;
  }

  const controller = new AbortController();
  const onSignal = () => { controller.abort(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  while (!controller.signal.aborted) {
    const now = new Date();
    const nextFire = nextFireTime(cron, now);
    const delayMs = nextFire.getTime() - Date.now();

    process.stderr.write(
      `[heimdall-schedule] Next triage at ${nextFire.toISOString()} (in ${formatDelay(delayMs)})\n`,
    );

    await sleep(delayMs, controller.signal);
    if (controller.signal.aborted) break;

    await runTriage(triageOpts);
  }

  process.stderr.write('[heimdall-schedule] Shutting down cleanly.\n');
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
}

// --- CLI arg parsing when run directly ---
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
  flue run triage --target node # run triage as a Flue workflow (for external schedulers)
`);
    process.exit(0);
  } else {
    process.stderr.write(`Error: unknown option: ${arg}\n`);
    process.exit(1);
  }
}

runScheduleMode(runOnce).catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[heimdall-schedule] Fatal error: ${detail}\n`);
  process.exit(1);
});
