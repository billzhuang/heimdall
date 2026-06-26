/**
 * GitHub Action runner — invoked by action.yml via `npx tsx`.
 *
 * Reads action inputs from environment variables prefixed with
 * `_HEIMDALL_ACTION_`, runs the appropriate Heimdall mode, and writes
 * outputs to $GITHUB_OUTPUT and optionally $GITHUB_STEP_SUMMARY.
 *
 * This file is intentionally not imported by any other module; it is the
 * action entrypoint only.  Pure helper logic lives in github-action.ts.
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normaliseSeverity,
  severityAtLeast,
  findingToOutputs,
  renderJobSummary,
  renderTriageJobSummary,
  detectTriageSeverity,
  type ActionSeverity,
} from './github-action.ts';
import type { OneShotFinding } from './format-output.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_PATH  = resolve(__dirname, '..', '..', 'bin', 'heimdall');

const MODE            = process.env['_HEIMDALL_ACTION_MODE'] ?? 'prompt';
const PROMPT          = process.env['_HEIMDALL_ACTION_PROMPT'] ?? '';
const NAMESPACE       = process.env['_HEIMDALL_ACTION_NAMESPACE'] ?? '';
const ALL_NAMESPACES  = process.env['_HEIMDALL_ACTION_ALL_NAMESPACES'] === 'true';
const FAIL_ON         = (process.env['_HEIMDALL_ACTION_FAIL_ON'] ?? '').trim();
const POST_SUMMARY    = process.env['_HEIMDALL_ACTION_POST_SUMMARY'] !== 'false';

const GITHUB_OUTPUT       = process.env['GITHUB_OUTPUT'] ?? '';
const GITHUB_STEP_SUMMARY = process.env['GITHUB_STEP_SUMMARY'] ?? '';

/** Append a name=value pair to $GITHUB_OUTPUT (multiline-safe). */
function setOutput(name: string, value: string): void {
  if (!GITHUB_OUTPUT) return;
  const delimiter = `_heimdall_eof_${name}_${Date.now()}`;
  appendFileSync(GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

/** Append markdown to $GITHUB_STEP_SUMMARY. */
function appendSummary(markdown: string): void {
  if (!GITHUB_STEP_SUMMARY) return;
  appendFileSync(GITHUB_STEP_SUMMARY, markdown + '\n');
}

/** Run a command, capture stdout+stderr, stream stderr to process.stderr. */
function capture(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn(cmd, args, {
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

  const severity = normaliseSeverity(finding.severity);
  checkFailOnSeverity(severity);
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

// ── Failure gating ─────────────────────────────────────────────────────────

function checkFailOnSeverity(severity: ActionSeverity): void {
  if (!FAIL_ON) return;
  const threshold = normaliseSeverity(FAIL_ON);
  if (severityAtLeast(severity, threshold)) {
    process.stderr.write(
      `[heimdall-action] Failing: detected severity "${severity}" meets fail-on-severity threshold "${threshold}"\n`,
    );
    process.exit(1);
  }
}

// ── Dispatch ───────────────────────────────────────────────────────────────

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
