/**
 * Heimdall self-loop mode.
 *
 * Closes the full automation cycle without human intervention:
 *   run evals → score → reflect → send to LLM → apply patches → re-score → keep/revert → repeat
 *
 * The loop stops when:
 *   - All scenarios pass (score = 1.0)
 *   - Max iterations reached
 *   - An iteration produces no improvement
 *
 * Usage:
 *   heimdall self-loop
 *   heimdall self-loop --max-iterations 5
 *   heimdall self-loop --dry-run
 *   heimdall self-loop --backend claude-cli
 */
import { spawn } from 'node:child_process';
import { writeFile, unlink, readdir, readFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import type { OneShotFinding } from './lib/format-output.ts';
import {
  buildLearningEntry,
  appendLearningEntry,
  resolveLogPath,
} from './lib/self-improve.ts';
import { readTaskHistory } from './lib/task-history.ts';
import { loadConfig } from './lib/config.ts';
import { callClaudeCli, isClaudeCliAvailable } from './lib/claude-cli-llm.ts';
import { callCodexCli, isCodexCliAvailable } from './lib/codex-cli-llm.ts';
import {
  scoreResults,
  buildAutoReflectionPrompt,
  parseProposals,
  applyProposals,
  revertToSnapshot,
  snapshotInstructions,
  extractInstructionsSnippet,
  type IterationResult,
} from './lib/self-loop.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EVAL_TIMEOUT_MS = 120_000;
const LEARNING_LOG_NAME = 'learning-log.jsonl';
const TASK_HISTORY_NAME = 'task-history.jsonl';
const DEFAULT_MAX_ITERATIONS = 3;

interface EvalScenario {
  description: string;
  mocks: Record<string, string>;
  prompt: string;
  expectedSeverity?: 'critical' | 'warning' | 'info';
  expectedKeywords?: string[];
  forbiddenKeywords?: string[];
}

interface EvalResult {
  scenario: string;
  prompt: string;
  passed: boolean;
  failures: string[];
  output?: OneShotFinding;
}

async function loadScenario(filePath: string): Promise<EvalScenario> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = loadYaml(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid scenario file: ${filePath} is not a valid YAML object`);
  }
  if (typeof parsed['prompt'] !== 'string' || !parsed['prompt']) {
    throw new Error(`Invalid scenario file: ${filePath} — missing required field "prompt"`);
  }
  if (typeof parsed['description'] !== 'string') {
    throw new Error(`Invalid scenario file: ${filePath} — missing required field "description"`);
  }
  return parsed as unknown as EvalScenario;
}

async function runScenario(scenarioPath: string, scenario: EvalScenario): Promise<EvalResult> {
  const tmpFile = join(tmpdir(), `heimdall-eval-${randomBytes(8).toString('hex')}.json`);
  await writeFile(tmpFile, JSON.stringify(scenario.mocks), 'utf8');

  const failures: string[] = [];
  let finding: OneShotFinding | undefined;

  try {
    const binPath = resolve(__dirname, '..', 'bin', 'heimdall');

    const rawOutput = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const safeReject = (err: Error) => { if (!settled) { settled = true; reject(err); } };
      const safeResolve = (val: string) => { if (!settled) { settled = true; resolve(val); } };

      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];

      const child = spawn(binPath, ['-p', scenario.prompt, '--json'], {
        env: { ...process.env, HEIMDALL_KUBECTL_MOCK: tmpFile, HEIMDALL_EVAL_MODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        safeReject(new Error(`scenario timed out after ${EVAL_TIMEOUT_MS / 1000}s`));
      }, EVAL_TIMEOUT_MS);

      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        const out = Buffer.concat(chunks).toString('utf8').trim();
        if (code !== 0) {
          const errOut = Buffer.concat(errChunks).toString('utf8').trim();
          safeReject(new Error(`agent exited with code ${code}: ${errOut || out}`));
        } else {
          safeResolve(out);
        }
      });

      child.on('error', (err: Error) => { clearTimeout(timer); safeReject(err); });
    });

    try {
      const parsed = JSON.parse(rawOutput);
      if (!parsed || typeof parsed !== 'object') {
        failures.push(`Invalid JSON output: expected an object, got ${rawOutput.slice(0, 200)}`);
      } else {
        finding = parsed as OneShotFinding;
      }
    } catch {
      failures.push(`Failed to parse JSON output: ${rawOutput.slice(0, 200)}`);
    }

    if (finding) {
      if (scenario.expectedSeverity && finding.severity !== scenario.expectedSeverity) {
        failures.push(`Severity: expected "${scenario.expectedSeverity}", got "${finding.severity}"`);
      }
      const fullText = `${finding.summary ?? ''} ${finding.answer ?? ''}`.toLowerCase();
      for (const kw of scenario.expectedKeywords ?? []) {
        if (!fullText.includes(kw.toLowerCase())) {
          failures.push(`Missing expected keyword: "${kw}"`);
        }
      }
      for (const kw of scenario.forbiddenKeywords ?? []) {
        if (fullText.includes(kw.toLowerCase())) {
          failures.push(`Found forbidden keyword: "${kw}"`);
        }
      }
    }
  } catch (err) {
    failures.push(`Agent error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try { await unlink(tmpFile); } catch { /* ignore */ }
  }

  return { scenario: scenario.description, prompt: scenario.prompt, passed: failures.length === 0, failures, output: finding };
}

async function loadScenarios(
  scenariosDir: string,
  filter?: string,
): Promise<Array<{ path: string; scenario: EvalScenario }>> {
  const files = await readdir(scenariosDir);
  const yamlFiles = files.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  const matched = filter ? yamlFiles.filter(f => f.toLowerCase().includes(filter.toLowerCase())) : yamlFiles;
  if (matched.length === 0 && filter) {
    throw new Error(`No scenario files matching "${filter}" found in ${scenariosDir}`);
  }
  return Promise.all(
    matched.map(async file => {
      const filePath = join(scenariosDir, file);
      const scenario = await loadScenario(filePath);
      return { path: filePath, scenario };
    }),
  );
}

async function runAllScenarios(scenarios: Array<{ path: string; scenario: EvalScenario }>): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const { path: scenarioPath, scenario } of scenarios) {
    process.stdout.write(`    Running: ${scenario.description}\n`);
    const result = await runScenario(scenarioPath, scenario);
    results.push(result);
    if (result.passed) {
      process.stdout.write(`    ✓ PASS  ${result.scenario}\n`);
    } else {
      process.stdout.write(`    ✗ FAIL  ${result.scenario}\n`);
      for (const f of result.failures) process.stdout.write(`           - ${f}\n`);
    }
  }
  return results;
}

async function callLlm(prompt: string, backend: string, timeoutMs: number): Promise<string> {
  if (backend === 'codex-cli') {
    return callCodexCli(prompt, { timeoutMs });
  }
  return callClaudeCli(prompt, { timeoutMs });
}

async function saveProposal(
  proposalsDir: string,
  iteration: number,
  llmResponse: string,
): Promise<void> {
  await mkdir(proposalsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(proposalsDir, `iteration-${iteration}-${ts}.txt`);
  await writeFile(file, llmResponse, 'utf8');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let dryRun = false;
  let backend = 'claude-cli';
  let scenarioFilter: string | undefined;
  let cliLogPath: string | undefined;
  let reflectionTimeoutMs = 180_000;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--max-iterations' || args[i] === '-n') && args[i + 1]) {
      maxIterations = parseInt(args[++i], 10);
      if (isNaN(maxIterations) || maxIterations < 1) {
        process.stderr.write('Error: --max-iterations must be a positive integer\n');
        process.exit(1);
      }
    } else if (args[i].startsWith('--max-iterations=')) {
      maxIterations = parseInt(args[i].slice('--max-iterations='.length), 10);
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if ((args[i] === '--backend' || args[i] === '-b') && args[i + 1]) {
      backend = args[++i];
    } else if (args[i].startsWith('--backend=')) {
      backend = args[i].slice('--backend='.length);
    } else if ((args[i] === '--scenario' || args[i] === '-s') && args[i + 1]) {
      scenarioFilter = args[++i];
    } else if (args[i].startsWith('--scenario=')) {
      scenarioFilter = args[i].slice('--scenario='.length);
    } else if ((args[i] === '--log-path' || args[i] === '-l') && args[i + 1]) {
      cliLogPath = args[++i];
    } else if ((args[i] === '--timeout') && args[i + 1]) {
      reflectionTimeoutMs = parseInt(args[++i], 10) * 1000;
    } else if (args[i] === '-h' || args[i] === '--help') {
      process.stdout.write(`Usage: heimdall self-loop [options]

Run the automated self-improvement loop: eval → reflect → patch → re-eval → keep/revert.

Options:
  --max-iterations, -n <N>  Maximum improvement iterations (default: ${DEFAULT_MAX_ITERATIONS})
  --dry-run                  Show proposals without applying them to instructions.ts
  --backend, -b <name>       LLM backend for reflection: 'claude-cli' (default) or 'codex-cli'
  --scenario, -s <name>      Run only scenarios whose filename contains <name>
  --log-path, -l <path>      Write the learning log to <path>
  --timeout <seconds>        LLM reflection timeout in seconds (default: 180)
  -h, --help                 Show this help message

The loop stops when:
  - All scenarios pass (score = 1.0)
  - An iteration produces no improvement
  - --max-iterations is reached

Proposals are saved to scenarios/self-loop-proposals/ for review.

Examples:
  heimdall self-loop                          # run up to 3 iterations
  heimdall self-loop --max-iterations 5       # run up to 5 iterations
  heimdall self-loop --dry-run                # show proposals only, do not apply
  heimdall self-loop --backend codex-cli      # use OpenAI Codex CLI for reflection
`);
      process.exit(0);
    }
  }

  if (!['claude-cli', 'codex-cli'].includes(backend)) {
    process.stderr.write(`Error: unknown backend '${backend}'; supported: claude-cli, codex-cli\n`);
    process.exit(1);
  }

  // Verify LLM backend is available.
  const backendAvailable = backend === 'codex-cli'
    ? await isCodexCliAvailable()
    : await isClaudeCliAvailable();

  if (!backendAvailable) {
    const cli = backend === 'codex-cli' ? 'codex' : 'claude';
    process.stderr.write(
      `Error: ${cli} CLI not found. Install it and authenticate before running self-loop.\n`,
    );
    process.exit(1);
  }

  const scenariosDir = resolve(__dirname, '..', 'scenarios');
  const proposalsDir = join(scenariosDir, 'self-loop-proposals');
  const config = loadConfig();
  const logPath = resolveLogPath(cliLogPath, config.learning?.logFile, join(scenariosDir, LEARNING_LOG_NAME));
  const taskHistoryPath = config.learning?.file
    ? resolve(config.learning.file)
    : join(scenariosDir, TASK_HISTORY_NAME);
  const instructionsPath = resolve(__dirname, 'lib', 'instructions.ts');

  let scenarios: Array<{ path: string; scenario: EvalScenario }>;
  try {
    scenarios = await loadScenarios(scenariosDir, scenarioFilter);
  } catch (err) {
    process.stderr.write(`Error loading scenarios: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  if (scenarios.length === 0) {
    process.stderr.write(`No scenario files found in ${scenariosDir}\n`);
    process.exit(1);
  }

  process.stdout.write(`\nHeimdall Self-Loop (max ${maxIterations} iteration${maxIterations === 1 ? '' : 's'})\n`);
  process.stdout.write(`Backend: ${backend} | Scenarios: ${scenarios.length} | Mode: ${dryRun ? 'dry-run' : 'apply'}\n`);
  process.stdout.write('='.repeat(60) + '\n\n');

  const iterationHistory: IterationResult[] = [];

  // Baseline run.
  process.stdout.write(`Baseline evaluation...\n`);
  let currentResults = await runAllScenarios(scenarios);
  let currentScore = scoreResults(currentResults);
  process.stdout.write(`Baseline score: ${(currentScore * 100).toFixed(0)}% (${currentResults.filter(r => r.passed).length}/${currentResults.length} passed)\n\n`);

  if (currentScore === 1) {
    process.stdout.write('All scenarios already pass. Nothing to improve.\n');
    return;
  }

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    process.stdout.write(`--- Iteration ${iteration}/${maxIterations} ---\n`);

    // Build learning entries from failures.
    const failedResults = currentResults.filter(r => !r.passed);
    const learningEntries = failedResults.map(r => buildLearningEntry(r.scenario, r.prompt, r.failures));

    // Persist learning entries.
    for (const entry of learningEntries) {
      await appendLearningEntry(entry, logPath);
    }

    // Read task history for context.
    const taskHistory = await readTaskHistory(taskHistoryPath);

    // Build and send reflection prompt.
    const instructionsContent = await snapshotInstructions(instructionsPath);
    const snippet = extractInstructionsSnippet(instructionsContent);
    const reflectionPrompt = buildAutoReflectionPrompt(learningEntries, taskHistory, snippet);

    process.stdout.write(`Sending reflection prompt to ${backend}...\n`);
    let llmResponse: string;
    try {
      llmResponse = await callLlm(reflectionPrompt, backend, reflectionTimeoutMs);
    } catch (err) {
      process.stderr.write(`LLM call failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.stdout.write('Stopping self-loop due to LLM error.\n');
      break;
    }

    // Save proposal for review.
    await saveProposal(proposalsDir, iteration, llmResponse);
    process.stdout.write(`Proposal saved to scenarios/self-loop-proposals/\n`);

    // Parse patches.
    const patches = parseProposals(llmResponse);
    process.stdout.write(`Parsed ${patches.length} patch${patches.length === 1 ? '' : 'es'}\n`);

    if (patches.length === 0) {
      process.stdout.write('LLM proposed no changes. Stopping self-loop.\n');
      iterationHistory.push({
        iteration,
        baselineScore: currentScore,
        newScore: currentScore,
        proposalCount: 0,
        appliedCount: 0,
        improved: false,
        reverted: false,
      });
      break;
    }

    if (dryRun) {
      process.stdout.write('\n[dry-run] Proposed patches:\n');
      patches.forEach((p, i) => {
        process.stdout.write(`  Patch ${i + 1}:\n    FIND: ${p.find.slice(0, 80).replace(/\n/g, '\\n')}...\n    REPLACE: ${p.replace.slice(0, 80).replace(/\n/g, '\\n')}...\n`);
      });
      process.stdout.write('\n[dry-run] Not applying patches. Stopping.\n');
      break;
    }

    // Take snapshot before applying.
    const snapshot = instructionsContent;

    // Apply patches.
    const appliedCount = await applyProposals(patches, instructionsPath);
    process.stdout.write(`Applied ${appliedCount}/${patches.length} patches to instructions.ts\n`);

    if (appliedCount === 0) {
      process.stdout.write('No patches matched current content. Stopping self-loop.\n');
      break;
    }

    // Re-score.
    process.stdout.write(`Re-running evals after patch...\n`);
    const newResults = await runAllScenarios(scenarios);
    const newScore = scoreResults(newResults);
    const improved = newScore > currentScore;

    process.stdout.write(
      `Score: ${(currentScore * 100).toFixed(0)}% → ${(newScore * 100).toFixed(0)}% ` +
      `(${improved ? '+' : ''}${((newScore - currentScore) * 100).toFixed(0)}pp)\n`,
    );

    iterationHistory.push({
      iteration,
      baselineScore: currentScore,
      newScore,
      proposalCount: patches.length,
      appliedCount,
      improved,
      reverted: !improved,
    });

    if (improved) {
      process.stdout.write('Score improved — keeping patches.\n\n');
      currentResults = newResults;
      currentScore = newScore;
      if (currentScore === 1) {
        process.stdout.write('All scenarios now pass! Self-loop complete.\n\n');
        break;
      }
    } else {
      process.stdout.write('Score did not improve — reverting patches.\n\n');
      await revertToSnapshot(snapshot, instructionsPath);
      // Stop after a non-improving iteration to avoid thrashing.
      break;
    }
  }

  // Summary report.
  process.stdout.write('='.repeat(60) + '\n');
  process.stdout.write('Self-Loop Summary\n');
  process.stdout.write('='.repeat(60) + '\n');

  if (iterationHistory.length === 0) {
    process.stdout.write('No iterations were run (all scenarios already passing or LLM unavailable).\n');
  } else {
    for (const r of iterationHistory) {
      const delta = ((r.newScore - r.baselineScore) * 100).toFixed(0);
      const status = r.reverted ? 'REVERTED' : r.improved ? 'KEPT' : 'NO_CHANGE';
      process.stdout.write(
        `  Iteration ${r.iteration}: ${(r.baselineScore * 100).toFixed(0)}% → ${(r.newScore * 100).toFixed(0)}%` +
        ` (${parseInt(delta, 10) >= 0 ? '+' : ''}${delta}pp) | ${r.appliedCount} patch${r.appliedCount === 1 ? '' : 'es'} | ${status}\n`,
      );
    }
    const finalScore = currentScore;
    process.stdout.write(`\nFinal score: ${(finalScore * 100).toFixed(0)}%\n`);

    const anyImproved = iterationHistory.some(r => r.improved);
    if (anyImproved) {
      process.stdout.write('instructions.ts was updated. Review changes with: git diff src/lib/instructions.ts\n');
    }
  }

  process.stdout.write('\nProposals saved to: scenarios/self-loop-proposals/\n');
  process.stdout.write('Learning entries saved to: ' + logPath + '\n');
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[heimdall-self-loop] Fatal error: ${detail}\n`);
  process.exit(1);
});
