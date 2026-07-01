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
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAlertManagerPayload, parsePagerDutyPayload, buildAlertPrompt, type ParsedAlert } from './lib/alert.ts';
import { runKubectl } from './lib/kubectl.ts';
import { loadConfig } from './lib/config.ts';
import { BLOCKED_PREFIX } from './lib/harness.ts';
import { resolveModel } from './lib/model.ts';
import { getMessage, getStackOrMessage } from './lib/error-utils.ts';
import { resolveBinPath } from './lib/eval-runner.ts';
import { interpretChildExit } from './lib/child-exit.ts';

const ALERT_TIMEOUT_MS = 300_000;
const __dirname = dirname(fileURLToPath(import.meta.url));

const config = loadConfig();

export function addKubectlResultIfValid(parts: string[], label: string, result: string): void {
  if (result && !result.startsWith('Error:') && !result.startsWith(BLOCKED_PREFIX)) {
    parts.push(`--- ${label} ---\n${result}`);
  }
}

/**
 * Pre-fetch kubectl data for the alerted resource.
 * Returns combined stdout suitable for embedding in the investigation prompt.
 */
async function seedKubectl(alert: ParsedAlert): Promise<string> {
  const parts: string[] = [];
  const opts = { audit: config.audit, redactSecrets: config.redactSecrets ?? true };

  if (alert.pod && alert.namespace) {
    addKubectlResultIfValid(parts, `kubectl describe pod ${alert.pod} -n ${alert.namespace}`,
      await runKubectl(`describe pod ${alert.pod} -n ${alert.namespace}`, opts).catch(() => ''));
    addKubectlResultIfValid(parts, `kubectl logs ${alert.pod} -n ${alert.namespace} --tail=50`,
      await runKubectl(`logs ${alert.pod} -n ${alert.namespace} --tail=50`, opts).catch(() => ''));
  } else if (alert.namespace) {
    addKubectlResultIfValid(parts, `kubectl get pods -n ${alert.namespace}`,
      await runKubectl(`get pods -n ${alert.namespace}`, opts).catch(() => ''));
    addKubectlResultIfValid(parts, `kubectl get events -n ${alert.namespace}`,
      await runKubectl(`get events -n ${alert.namespace} --sort-by=.lastTimestamp`, opts).catch(() => ''));
  }

  return parts.join('\n\n');
}

async function runAgent(prompt: string, model?: string): Promise<void> {
  const binPath = resolveBinPath(__dirname);
  return new Promise((res, rej) => {
    let settled = false;
    const settle = (err?: Error) => { if (!settled) { settled = true; if (err) rej(err); else res(); } };

    const env = model ? { ...process.env, HEIMDALL_MODEL: model } : process.env;
    const child = spawn(binPath, ['-p', prompt], { stdio: ['ignore', 'inherit', 'inherit'], env });
    const timer = setTimeout(() => { child.kill('SIGTERM'); settle(new Error('alert investigation timed out')); }, ALERT_TIMEOUT_MS);

    child.on('close', (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      settle(interpretChildExit(code, signal) ?? undefined);
    });
    child.on('error', (err: Error) => { clearTimeout(timer); settle(err); });
  });
}

type AlertSource = 'grafana' | 'prometheus' | 'pagerduty' | 'raw';

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
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  let source: AlertSource = 'raw';
  let seed = true;
  let input = '';
  let modelFlag: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--source' || arg === '-s') && args[i + 1]) {
      const s = args[++i];
      if (s !== 'grafana' && s !== 'prometheus' && s !== 'pagerduty' && s !== 'raw') {
        process.stderr.write(`Error: --source must be grafana, prometheus, pagerduty, or raw\n`); process.exit(1);
      }
      source = s;
    } else if (arg.startsWith('--source=')) {
      const s = arg.slice('--source='.length);
      if (s !== 'grafana' && s !== 'prometheus' && s !== 'pagerduty' && s !== 'raw') {
        process.stderr.write(`Error: --source must be grafana, prometheus, pagerduty, or raw\n`); process.exit(1);
      }
      source = s as AlertSource;
    } else if (arg === '--no-seed') {
      seed = false;
    } else if (arg === '--model') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) {
        process.stderr.write(`Error: --model requires a value\n`); process.exit(1);
      }
      modelFlag = args[++i];
    } else if (arg.startsWith('--model=')) {
      const m = arg.slice('--model='.length);
      if (!m) {
        process.stderr.write(`Error: --model= requires a non-empty value\n`); process.exit(1);
      }
      modelFlag = m;
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

  let resolvedModel: string;
  try {
    resolvedModel = resolveModel(modelFlag);
  } catch (err) {
    process.stderr.write(`Error: ${getMessage(err)}\n`);
    process.exit(1);
  }

  runAlertMode({ source, input, seed, model: resolvedModel }).catch((err: unknown) => {
    process.stderr.write(`[heimdall-alert] Fatal: ${getStackOrMessage(err)}\n`);
    process.exit(1);
  });
}
