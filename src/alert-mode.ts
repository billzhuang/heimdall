/**
 * Heimdall alert mode.
 *
 * Accepts an alert payload (AlertManager v4 JSON or raw text) and runs a
 * targeted investigation. Before handing off to the LLM, it optionally seeds
 * the prompt with live kubectl data for the affected pod/namespace.
 *
 * Usage:
 *   heimdall alert [--source grafana|prometheus|raw] [--no-seed] <alert.json|"text">
 *   npm run alert -- --source grafana alert.json
 *   npm run alert -- --source raw "Pod api-xyz in prod is CrashLoopBackOff"
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAlertManagerPayload, parsePagerDutyPayload, buildAlertPrompt, type ParsedAlert } from './lib/alert.ts';
import { runKubectl, type RunKubectlOptions } from './lib/kubectl.ts';
import { loadConfig } from './lib/config.ts';
import { BLOCKED_PREFIX } from './lib/harness.ts';
import { getStackOrMessage } from './lib/error-utils.ts';
import { resolveBinPath } from './lib/bin-path.ts';
import { interpretChildExit } from './lib/child-exit.ts';
import { spawnAndCollect } from './lib/spawn-collect.ts';
import { parseModelFlag, isMainModule, resolveModelOrExit } from './lib/cli-args.ts';

const ALERT_TIMEOUT_MS = 300_000;
const __dirname = dirname(fileURLToPath(import.meta.url));

const config = loadConfig();

export function addKubectlResultIfValid(parts: string[], label: string, result: string): void {
  if (result && !result.startsWith('Error:') && !result.startsWith(BLOCKED_PREFIX)) {
    parts.push(`--- ${label} ---\n${result}`);
  }
}

/**
 * Run one read-only kubectl command and append its output to `parts` if valid.
 * `label` defaults to `kubectl <args>`; pass an explicit label when it must
 * differ from the executed command (e.g. a display label that omits flags).
 */
async function fetchKubectl(
  parts: string[],
  opts: RunKubectlOptions,
  args: string,
  label = `kubectl ${args}`,
): Promise<void> {
  addKubectlResultIfValid(parts, label, await runKubectl(args, opts).catch(() => ''));
}

/**
 * Pre-fetch kubectl data for the alerted resource.
 * Returns combined stdout suitable for embedding in the investigation prompt.
 */
export async function seedKubectl(alert: ParsedAlert): Promise<string> {
  const parts: string[] = [];
  const opts = { audit: config.audit, redactSecrets: config.redactSecrets ?? true };

  if (alert.pod && alert.namespace) {
    await fetchKubectl(parts, opts, `describe pod ${alert.pod} -n ${alert.namespace}`);
    await fetchKubectl(parts, opts, `logs ${alert.pod} -n ${alert.namespace} --tail=50`);
  } else if (alert.namespace) {
    await fetchKubectl(parts, opts, `get pods -n ${alert.namespace}`);
    await fetchKubectl(parts, opts, `get events -n ${alert.namespace} --sort-by=.lastTimestamp`, `kubectl get events -n ${alert.namespace}`);
  }

  return parts.join('\n\n');
}

export async function runAgent(prompt: string, model?: string): Promise<void> {
  const binPath = resolveBinPath(__dirname);
  const env = model ? { ...process.env, HEIMDALL_MODEL: model } : process.env;
  await spawnAndCollect(binPath, ['-p', prompt], {
    env,
    timeoutMs: ALERT_TIMEOUT_MS,
    stdio: 'inherit',
    onTimeout: () => new Error('alert investigation timed out'),
    onExit: (code, signal) => interpretChildExit(code, signal),
  });
}

type AlertSource = 'grafana' | 'prometheus' | 'pagerduty' | 'raw';

const ALERT_SOURCES: readonly AlertSource[] = ['grafana', 'prometheus', 'pagerduty', 'raw'];

/**
 * Validate a raw `--source` CLI value against the known alert-source picklist.
 * Writes an error to stderr and exit(1)s on an unrecognized value.
 */
export function validateSourceArg(value: string): AlertSource {
  if (!(ALERT_SOURCES as readonly string[]).includes(value)) {
    const list = `${ALERT_SOURCES.slice(0, -1).join(', ')}, or ${ALERT_SOURCES[ALERT_SOURCES.length - 1]}`;
    process.stderr.write(`Error: --source must be ${list}\n`);
    process.exit(1);
  }
  return value as AlertSource;
}

export async function runAlertMode(opts: { source: AlertSource; input: string; seed: boolean; model?: string }): Promise<void> {
  let alerts: ParsedAlert[];

  if (opts.source === 'raw') {
    alerts = [{ alertname: 'Manual alert', description: opts.input, labels: {} }];
  } else {
    let jsonText: string;
    if (existsSync(opts.input)) {
      try { jsonText = readFileSync(opts.input, 'utf-8'); }
      catch (err) { process.stderr.write(`[heimdall-alert] Cannot read ${opts.input}: ${err}\n`); process.exit(1); }
    } else {
      jsonText = opts.input;
    }
    let payload: unknown;
    try { payload = JSON.parse(jsonText); }
    catch { process.stderr.write('[heimdall-alert] Invalid JSON payload\n'); process.exit(1); }

    if (opts.source === 'pagerduty') {
      const serviceMap = config.alert?.pagerduty?.serviceMap ?? {};
      alerts = parsePagerDutyPayload(payload, serviceMap);
    } else {
      alerts = parseAlertManagerPayload(payload);
    }
    if (alerts.length === 0) { process.stderr.write('[heimdall-alert] No alerts found in payload\n'); process.exit(1); }
  }

  const alert = alerts[0];
  process.stderr.write(`[heimdall-alert] Investigating: ${alert.alertname}${alert.namespace ? ` in ${alert.namespace}` : ''}\n`);
  if (alerts.length > 1) {
    process.stderr.write(`[heimdall-alert] ${alerts.length - 1} additional alert(s) in payload — investigating the first one\n`);
  }

  let seedContext = '';
  if (opts.seed && (alert.pod || alert.namespace)) {
    process.stderr.write('[heimdall-alert] Pre-fetching kubectl context...\n');
    seedContext = await seedKubectl(alert).catch((err) => {
      process.stderr.write(`[heimdall-alert] Seed phase failed (proceeding without): ${err}\n`);
      return '';
    });
  }

  const prompt = buildAlertPrompt(alert, seedContext || undefined);
  await runAgent(prompt, opts.model);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  let source: AlertSource = 'raw';
  let seed = true;
  let input = '';
  let modelFlag: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--source' || arg === '-s') && args[i + 1]) {
      source = validateSourceArg(args[++i]);
    } else if (arg.startsWith('--source=')) {
      source = validateSourceArg(arg.slice('--source='.length));
    } else if (arg === '--no-seed') {
      seed = false;
    } else if (arg === '--model' || arg.startsWith('--model=')) {
      const parsed = parseModelFlag(args, i);
      modelFlag = parsed.value;
      i = parsed.nextIndex;
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(`Usage: heimdall alert [--source grafana|prometheus|pagerduty|raw] [--no-seed] <alert.json|"text">

Options:
  --source <type>           Alert format: grafana, prometheus, pagerduty, or raw text (default: raw)
  --no-seed                 Skip pre-fetching kubectl data before the LLM investigation
  --model <provider/model>  Override the LLM model (default: anthropic/claude-sonnet-4-6)
  -h, --help                Show this help

Examples:
  heimdall alert alert.json
  heimdall alert --source grafana grafana-alert.json
  heimdall alert --source prometheus alertmanager-webhook.json
  heimdall alert --source pagerduty pd-webhook.json
  heimdall alert --source raw "Pod api-xyz in namespace prod is CrashLoopBackOff"
  npm run alert -- --source raw "high latency on api deployment in prod"
`);
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      input = arg;
    } else {
      process.stderr.write(`Error: unknown option: ${arg}\n`); process.exit(1);
    }
  }

  if (!input) {
    process.stderr.write('Error: alert input (file path or raw text) is required\n');
    process.stderr.write('Usage: heimdall alert [--source grafana|prometheus|raw] [--no-seed] <alert.json|"text">\n');
    process.exit(1);
  }

  const resolvedModel = resolveModelOrExit(modelFlag);

  runAlertMode({ source, input, seed, model: resolvedModel }).catch((err: unknown) => {
    process.stderr.write(`[heimdall-alert] Fatal: ${getStackOrMessage(err)}\n`);
    process.exit(1);
  });
}
