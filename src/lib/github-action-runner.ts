/**
 * GitHub Action runner — invoked by action.yml via `npx tsx`.
 *
 * Reads action inputs from environment variables prefixed with
 * `_HEIMDALL_ACTION_`, runs the appropriate Heimdall mode, and writes
 * outputs to $GITHUB_OUTPUT and optionally $GITHUB_STEP_SUMMARY.
 *
 * Exported helpers (`setOutput`, `appendSummary`, `capture`, `readActionConfig`,
 * `checkFailOnSeverity`, `runPromptMode`, `runTriageMode`, `runScheduleOnceMode`)
 * are unit-tested without spawning a real process or touching process.env.
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

/**
 * All environment-derived settings for a single action run.
 * Grouped so that mode functions can be called directly in tests
 * without mutating process.env.
 */
export interface ActionConfig {
  mode: string;
  prompt: string;
  namespace: string;
  allNamespaces: boolean;
  failOn: string;
  postSummary: boolean;
  githubOutput: string;
  githubStepSummary: string;
}

/** Read action config from environment variables (called once in main). */
export function readActionConfig(): ActionConfig {
  return {
    mode: process.env['_HEIMDALL_ACTION_MODE'] ?? 'prompt',
    prompt: process.env['_HEIMDALL_ACTION_PROMPT'] ?? '',
    namespace: process.env['_HEIMDALL_ACTION_NAMESPACE'] ?? '',
    allNamespaces: process.env['_HEIMDALL_ACTION_ALL_NAMESPACES'] === 'true',
    failOn: (process.env['_HEIMDALL_ACTION_FAIL_ON'] ?? '').trim(),
    postSummary: process.env['_HEIMDALL_ACTION_POST_SUMMARY'] !== 'false',
    githubOutput: process.env['GITHUB_OUTPUT'] ?? '',
    githubStepSummary: process.env['GITHUB_STEP_SUMMARY'] ?? '',
  };
}

/**
 * Append a name=value pair to a GitHub Actions output file (multiline-safe).
 *
 * `outputPath` defaults to $GITHUB_OUTPUT; pass an explicit path in tests to
 * avoid touching environment variables.
 */
export function setOutput(name: string, value: string, outputPath = process.env['GITHUB_OUTPUT'] ?? ''): void {
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
export function appendSummary(markdown: string, summaryPath = process.env['GITHUB_STEP_SUMMARY'] ?? ''): void {
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

/** Evaluate the fail-on threshold and exit if the detected severity meets it. */
export function checkFailOnSeverity(failOn: string, severity: ActionSeverity): void {
  const decision = evaluateFailOn(failOn, severity);
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

// ── Shared capture type ─────────────────────────────────────────────────────

type CaptureFn = typeof capture;

// ── Prompt mode ────────────────────────────────────────────────────────────

/**
 * Run Heimdall in prompt mode and write outputs.
 * `captureImpl` can be replaced with a mock in unit tests.
 */
export async function runPromptMode(config: ActionConfig, captureImpl: CaptureFn = capture): Promise<void> {
  if (!config.prompt) {
    process.stderr.write('[heimdall-action] Error: prompt input is required for prompt mode\n');
    process.exit(1);
  }

  const { stdout, code } = await captureImpl(BIN_PATH, ['-p', config.prompt, '--json', '--no-learn']);
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
    setOutput(key, value, config.githubOutput);
  }

  const summaryMd = renderJobSummary(finding, config.prompt);
  setOutput('summary-markdown', summaryMd, config.githubOutput);

  if (config.postSummary) {
    appendSummary(summaryMd, config.githubStepSummary);
  }

  checkFailOnSeverity(config.failOn, normaliseSeverity(finding.severity));
}

// ── Triage mode ────────────────────────────────────────────────────────────

/**
 * Run Heimdall in triage mode and write outputs.
 * `captureImpl` can be replaced with a mock in unit tests.
 */
export async function runTriageMode(config: ActionConfig, captureImpl: CaptureFn = capture): Promise<void> {
  const extraArgs: string[] = [];
  if (config.allNamespaces) {
    extraArgs.push('-A');
  } else if (config.namespace) {
    extraArgs.push('-n', config.namespace);
  }

  const { stdout, code } = await captureImpl(BIN_PATH, ['triage', ...extraArgs]);
  if (code !== 0) {
    process.stderr.write(`[heimdall-action] Heimdall triage exited with code ${code}\n`);
    process.exit(code);
  }

  const severity = detectTriageSeverity(stdout);
  setOutput('severity', severity, config.githubOutput);
  setOutput('summary', '', config.githubOutput);
  setOutput('answer', '', config.githubOutput);
  setOutput('suggested-commands', '', config.githubOutput);
  setOutput('remediation-steps', '', config.githubOutput);

  const summaryMd = renderTriageJobSummary(stdout);
  setOutput('summary-markdown', summaryMd, config.githubOutput);

  if (config.postSummary) {
    appendSummary(summaryMd, config.githubStepSummary);
  }

  checkFailOnSeverity(config.failOn, severity);
}

// ── Schedule-once mode ─────────────────────────────────────────────────────

/**
 * Run Heimdall schedule --once and write outputs.
 * `captureImpl` can be replaced with a mock in unit tests.
 */
export async function runScheduleOnceMode(config: ActionConfig, captureImpl: CaptureFn = capture): Promise<void> {
  const { code } = await captureImpl(BIN_PATH, ['schedule', '--once']);
  if (code !== 0) {
    process.stderr.write(`[heimdall-action] Heimdall schedule exited with code ${code}\n`);
    process.exit(code);
  }

  const summaryMd = '## Heimdall Schedule\n\nScheduled triage completed.';
  setOutput('severity', 'ok', config.githubOutput);
  setOutput('summary', 'Scheduled triage completed.', config.githubOutput);
  setOutput('answer', '', config.githubOutput);
  setOutput('suggested-commands', '', config.githubOutput);
  setOutput('remediation-steps', '', config.githubOutput);
  setOutput('summary-markdown', summaryMd, config.githubOutput);

  if (config.postSummary) {
    appendSummary(summaryMd, config.githubStepSummary);
  }

  checkFailOnSeverity(config.failOn, 'ok');
}

// ── Dispatch ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = readActionConfig();
  switch (config.mode) {
    case 'triage':
      await runTriageMode(config);
      break;
    case 'schedule-once':
      await runScheduleOnceMode(config);
      break;
    case 'prompt':
    default:
      await runPromptMode(config);
      break;
  }
}

// Only run when this file is the entry point, not when imported by tests.
if (process.argv[1] === __filename) {
  await main();
}
