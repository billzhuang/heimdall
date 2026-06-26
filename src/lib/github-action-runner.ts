/**
 * GitHub Action runner — invoked by action.yml via `npx tsx`.
 *
 * Reads action inputs from environment variables prefixed with
 * `_HEIMDALL_ACTION_`, runs the appropriate Heimdall mode, and writes
 * outputs to $GITHUB_OUTPUT and optionally $GITHUB_STEP_SUMMARY.
 *
 * The file exports testable I/O helpers (`setOutput`, `appendSummary`,
 * `capture`) so they can be unit-tested without spawning a real process.
 * Pure, side-effect-free logic lives in github-action.ts.
 * The dispatch (`main`) only fires when this file is the process entry point.
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normaliseSeverity,
  findingToOutputs,
  renderJobSummary,
  renderTriageJobSummary,
  detectTriageSeverity,
  evaluateFailOn,
  VALID_FAIL_ON_SEVERITIES,
  type ActionSeverity,
} from './github-action.ts';
import type { OneShotFinding } from './format-output.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const BIN_PATH   = resolve(__dirname, '..', '..', 'bin', 'heimdall');

const MODE           = process.env['_HEIMDALL_ACTION_MODE'] ?? 'prompt';
const PROMPT         = process.env['_HEIMDALL_ACTION_PROMPT'] ?? '';
const NAMESPACE      = process.env['_HEIMDALL_ACTION_NAMESPACE'] ?? '';
const ALL_NAMESPACES = process.env['_HEIMDALL_ACTION_ALL_NAMESPACES'] === 'true';
const FAIL_ON        = (process.env['_HEIMDALL_ACTION_FAIL_ON'] ?? '').trim();
const POST_SUMMARY   = process.env['_HEIMDALL_ACTION_POST_SUMMARY'] !== 'false';

const GITHUB_OUTPUT       = process.env['GITHUB_OUTPUT'] ?? '';
const GITHUB_STEP_SUMMARY = process.env['GITHUB_STEP_SUMMARY'] ?? '';

/**
 * Append a name=value pair to a GitHub Actions output file (multiline-safe).
 *
 * `outputPath` defaults to $GITHUB_OUTPUT; pass an explicit path in tests to
 * avoid touching environment variables.
 */
export function setOutput(name: string, value: string, outputPath = GITHUB_OUTPUT): void {
  if (!outputPath) return;
  const delimiter = `_heimdall_eof_${name}_${Date.now()}`;
  appendFileSync(outputPath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

/**
 * Append markdown to a GitHub step-summary file.
 *
 * `summaryPath` defaults to $GITHUB_STEP_SUMMARY; pass an explicit path in
 * tests to avoid touching environment variables.
 */
export function appendSummary(markdown: string, summaryPath = GITHUB_STEP_SUMMARY): void {
  if (!summaryPath) return;
  appendFileSync(summaryPath, markdown + '\n');
}

/**
 * Run a command, capture stdout, stream stderr to process.stderr.
 *
 * When spawning the Heimdall shell script (`BIN_PATH`) we invoke it via
 * `process.execPath` (the current Node.js binary) so the runner works on
 * Windows hosts where extensionless files cannot be spawned directly.
 */
export function capture(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    let stdout = '';
    // On Windows, shell scripts must be launched through an interpreter;
    // use the running Node binary so this file remains the single entrypoint.
    const isShellScript = cmd === BIN_PATH;
    const spawnCmd  = isShellScript ? process.execPath : cmd;
    const spawnArgs = isShellScript ? [BIN_PATH, ...args] : args;
    const child = spawn(spawnCmd, spawnArgs, {
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.on('close', (code) => resolve({ stdout, code: code ?? 1 }));
    child.on('error', (err) => {
      process.stderr.write(`[heimdall-action] spawn error: ${err.message}\n`);
      resolve({ stdout, code: 1 });
    });
  });
}

// ── Failure gating ─────────────────────────────────────────────────────────

function checkFailOnSeverity(severity: ActionSeverity): void {
  const decision = evaluateFailOn(FAIL_ON, severity);
  if (decision.ok) return;
  if (decision.reason === 'invalid-value') {
    process.stderr.write(
      `[heimdall-action] Error: invalid fail-on-severity value "${decision.value}". ` +
      `Expected one of: ${VALID_FAIL_ON_SEVERITIES.join(', ')}\n`,
    );
    process.exit(1);
  }
  process.stderr.write(
    `[heimdall-action] Failing: detected severity "${decision.found}" meets fail-on-severity threshold "${decision.threshold}"\n`,
  );
  process.exit(1);
}

// ── Prompt mode ────────────────────────────────────────────────────────────

async function runPromptMode(): Promise<void> {
  if (!PROMPT) {
    process.stderr.write('[heimdall-action] Error: prompt input is required for prompt mode\n');
    process.exit(1);
  }

  const { stdout, code } = await capture(BIN_PATH, ['-p', PROMPT, '--json', '--no-learn']);
  if (code !== 0) {
    process.stderr.write(`[heimdall-action] Heimdall exited with code ${code}\n`);
    process.exit(code);
  }

  let finding: OneShotFinding;
  try {
    finding = JSON.parse(stdout.trim()) as OneShotFinding;
  } catch {
    process.stderr.write(`[heimdall-action] Could not parse Heimdall JSON output:\n${stdout}\n`);
    process.exit(1);
  }

  const outputs = findingToOutputs(finding);
  for (const [key, value] of Object.entries(outputs)) {
    setOutput(key, value);
  }

  const summaryMd = renderJobSummary(finding, PROMPT);
  setOutput('summary-markdown', summaryMd);

  if (POST_SUMMARY) {
    appendSummary(summaryMd);
  }

  checkFailOnSeverity(normaliseSeverity(finding.severity));
}

// ── Triage mode ────────────────────────────────────────────────────────────

async function runTriageMode(): Promise<void> {
  const extraArgs: string[] = [];
  if (ALL_NAMESPACES) {
    extraArgs.push('-A');
  } else if (NAMESPACE) {
    extraArgs.push('-n', NAMESPACE);
  }

  const { stdout, code } = await capture(BIN_PATH, ['triage', ...extraArgs]);
  if (code !== 0) {
    process.stderr.write(`[heimdall-action] Heimdall triage exited with code ${code}\n`);
    process.exit(code);
  }

  const severity = detectTriageSeverity(stdout);
  setOutput('severity', severity);
  setOutput('summary', '');
  setOutput('answer', '');
  setOutput('suggested-commands', '');
  setOutput('remediation-steps', '');

  const summaryMd = renderTriageJobSummary(stdout);
  setOutput('summary-markdown', summaryMd);

  if (POST_SUMMARY) {
    appendSummary(summaryMd);
  }

  checkFailOnSeverity(severity);
}

// ── Schedule-once mode ─────────────────────────────────────────────────────

async function runScheduleOnceMode(): Promise<void> {
  const { code } = await capture(BIN_PATH, ['schedule', '--once']);
  if (code !== 0) {
    process.stderr.write(`[heimdall-action] Heimdall schedule exited with code ${code}\n`);
    process.exit(code);
  }

  setOutput('severity', 'ok');
  setOutput('summary', 'Scheduled triage completed.');
  setOutput('answer', '');
  setOutput('suggested-commands', '');
  setOutput('remediation-steps', '');
  setOutput('summary-markdown', '');
}

// ── Dispatch ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  switch (MODE) {
    case 'triage':
      await runTriageMode();
      break;
    case 'schedule-once':
      await runScheduleOnceMode();
      break;
    case 'prompt':
    default:
      await runPromptMode();
      break;
  }
}

// Only run when this file is the entry point, not when imported by tests.
if (process.argv[1] === __filename) {
  await main();
}
