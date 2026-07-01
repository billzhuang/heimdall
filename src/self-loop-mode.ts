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
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadScenarios,
  runAllScenarios,
  type EvalResult,
  type RunCallbacks,
} from './lib/eval-runner.ts';
import { resolveBinPath } from './lib/bin-path.ts';
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
import { getMessage, getStackOrMessage } from './lib/error-utils.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Write an error to stderr and exit(1) when n is not a positive integer. */
export function requirePositiveInt(n: number, msg: string): void {
  if (isNaN(n) || n < 1) {
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  }
}

const LEARNING_LOG_NAME = 'learning-log.jsonl';
const TASK_HISTORY_NAME = 'task-history.jsonl';
const DEFAULT_MAX_ITERATIONS = 3;

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
      requirePositiveInt(maxIterations, '--max-iterations must be a positive integer');
    } else if (args[i].startsWith('--max-iterations=')) {
      maxIterations = parseInt(args[i].slice('--max-iterations='.length), 10);
      requirePositiveInt(maxIterations, '--max-iterations must be a positive integer');
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
    } else if (args[i] === '--timeout' && args[i + 1]) {
      const secs = parseInt(args[++i], 10);
      requirePositiveInt(secs, '--timeout must be a positive integer (seconds)');
      reflectionTimeoutMs = secs * 1000;
    } else if (args[i].startsWith('--timeout=')) {
      const secs = parseInt(args[i].slice('--timeout='.length), 10);
      requirePositiveInt(secs, '--timeout must be a positive integer (seconds)');
      reflectionTimeoutMs = secs * 1000;
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
    } else {
      process.stderr.write(`Error: unknown option '${args[i]}'\nRun with --help for usage.\n`);
      process.exit(1);
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
  const instructionsPath = resolve(__dirname, '..', 'src', 'lib', 'instructions.ts');
  const binPath = resolveBinPath(__dirname);

  let scenarios: Awaited<ReturnType<typeof loadScenarios>>;
  try {
    scenarios = await loadScenarios(scenariosDir, scenarioFilter);
  } catch (err) {
    process.stderr.write(`Error loading scenarios: ${getMessage(err)}\n`);
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

  const callbacks: RunCallbacks = {
    onBefore: name => process.stdout.write(`    Running: ${name}\n`),
    onResult: result => {
      if (result.passed) {
        process.stdout.write(`    ✓ PASS  ${result.scenario}\n`);
      } else {
        process.stdout.write(`    ✗ FAIL  ${result.scenario}\n`);
        for (const f of result.failures) process.stdout.write(`           - ${f}\n`);
      }
    },
  };

  const runAndPrint = async (label: string) => {
    process.stdout.write(`${label}\n`);
    return runAllScenarios(binPath, scenarios, callbacks);
  };

  // Baseline run.
  let currentResults = await runAndPrint('Baseline evaluation...');
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
      process.stderr.write(`LLM call failed: ${getMessage(err)}\n`);
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

    // Apply patches, reverting to snapshot on any unexpected error.
    let appliedCount = 0;
    let newResults: EvalResult[];
    let newScore: number;
    let improved: boolean;
    try {
      appliedCount = await applyProposals(patches, instructionsPath);
      process.stdout.write(`Applied ${appliedCount}/${patches.length} patches to instructions.ts\n`);

      if (appliedCount === 0) {
        process.stdout.write('No patches matched current content. Stopping self-loop.\n');
        break;
      }

      // Re-score.
      newResults = await runAndPrint('Re-running evals after patch...');
      newScore = scoreResults(newResults);
      improved = newScore > currentScore;
    } catch (err) {
      process.stderr.write(`Error during patch/eval: ${getMessage(err)}\n`);
      process.stdout.write('Reverting patches due to error.\n');
      await revertToSnapshot(snapshot, instructionsPath);
      break;
    }

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
    process.stdout.write(`\nFinal score: ${(currentScore * 100).toFixed(0)}%\n`);

    if (iterationHistory.some(r => r.improved)) {
      process.stdout.write('instructions.ts was updated. Review changes with: git diff src/lib/instructions.ts\n');
    }
  }

  process.stdout.write('\nProposals saved to: scenarios/self-loop-proposals/\n');
  process.stdout.write('Learning entries saved to: ' + logPath + '\n');
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    process.stderr.write(`[heimdall-self-loop] Fatal error: ${getStackOrMessage(err)}\n`);
    process.exit(1);
  });
}
