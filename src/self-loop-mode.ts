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
  loadScenariosOrExit,
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
import { readTaskHistory, resolveTaskHistoryFilePath } from './lib/task-history.ts';
import { loadConfig } from './lib/config.ts';
import { callClaudeCli, isClaudeCliAvailable } from './lib/claude-cli-llm.ts';
import { callCodexCli, isCodexCliAvailable } from './lib/codex-cli-llm.ts';
import {
  scoreResults,
  formatPct,
  buildStartupBanner,
  formatDryRunPreview,
  formatScoreChangeLine,
  buildSummaryReport,
  buildAutoReflectionPrompt,
  parseProposals,
  applyProposals,
  revertToSnapshot,
  snapshotInstructions,
  extractInstructionsSnippet,
  type IterationResult,
} from './lib/self-loop.ts';
import { getMessage, getStackOrMessage } from './lib/error-utils.ts';
import { isMainModule, parseAliasedFlag } from './lib/cli-args.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Write an error to stderr and exit(1) when n is not a positive integer. */
export function requirePositiveInt(n: number, msg: string): void {
  if (isNaN(n) || n < 1) {
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  }
}

const LEARNING_LOG_NAME = 'learning-log.jsonl';
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

/** Paths and callbacks a single self-loop iteration needs, threaded through from `main()`. */
export interface IterationContext {
  backend: string;
  reflectionTimeoutMs: number;
  dryRun: boolean;
  logPath: string;
  taskHistoryPath: string;
  instructionsPath: string;
  proposalsDir: string;
  /** Runs the eval suite and prints progress; injected so tests can avoid spawning real evals. */
  runAndPrint: (label: string) => Promise<EvalResult[]>;
  /** Calls the reflection LLM; injected so tests can avoid spawning a real CLI backend. */
  callLlmFn: (prompt: string, backend: string, timeoutMs: number) => Promise<string>;
}

export interface IterationOutcome {
  /** Whether the self-loop should stop after this iteration. */
  stop: boolean;
  /** The IterationResult to record, when this iteration reached a scored outcome. */
  pushResult?: IterationResult;
  currentResults: EvalResult[];
  currentScore: number;
}

/**
 * Run one self-loop iteration: build a reflection prompt from current failures,
 * send it to the LLM, parse and apply proposed patches, re-score, and decide
 * whether to keep or revert. Extracted from `main()` so it is unit-testable
 * independent of CLI arg parsing and process-lifecycle concerns.
 */
export async function runIteration(
  iteration: number,
  currentResults: EvalResult[],
  currentScore: number,
  ctx: IterationContext,
): Promise<IterationOutcome> {
  // Build learning entries from failures.
  const failedResults = currentResults.filter(r => !r.passed);
  const learningEntries = failedResults.map(r => buildLearningEntry(r.scenario, r.prompt, r.failures));

  // Persist learning entries.
  for (const entry of learningEntries) {
    await appendLearningEntry(entry, ctx.logPath);
  }

  // Read task history for context.
  const taskHistory = await readTaskHistory(ctx.taskHistoryPath);

  // Build and send reflection prompt.
  const instructionsContent = await snapshotInstructions(ctx.instructionsPath);
  const snippet = extractInstructionsSnippet(instructionsContent);
  const reflectionPrompt = buildAutoReflectionPrompt(learningEntries, taskHistory, snippet);

  process.stdout.write(`Sending reflection prompt to ${ctx.backend}...\n`);
  let llmResponse: string;
  try {
    llmResponse = await ctx.callLlmFn(reflectionPrompt, ctx.backend, ctx.reflectionTimeoutMs);
  } catch (err) {
    process.stderr.write(`LLM call failed: ${getMessage(err)}\n`);
    process.stdout.write('Stopping self-loop due to LLM error.\n');
    return { stop: true, currentResults, currentScore };
  }

  // Save proposal for review.
  await saveProposal(ctx.proposalsDir, iteration, llmResponse);
  process.stdout.write(`Proposal saved to scenarios/self-loop-proposals/\n`);

  // Parse patches.
  const patches = parseProposals(llmResponse);
  process.stdout.write(`Parsed ${patches.length} patch${patches.length === 1 ? '' : 'es'}\n`);

  if (patches.length === 0) {
    process.stdout.write('LLM proposed no changes. Stopping self-loop.\n');
    return {
      stop: true,
      pushResult: {
        iteration,
        baselineScore: currentScore,
        newScore: currentScore,
        proposalCount: 0,
        appliedCount: 0,
        improved: false,
        reverted: false,
      },
      currentResults,
      currentScore,
    };
  }

  if (ctx.dryRun) {
    process.stdout.write(formatDryRunPreview(patches));
    return { stop: true, currentResults, currentScore };
  }

  // Take snapshot before applying.
  const snapshot = instructionsContent;

  // Apply patches, reverting to snapshot on any unexpected error.
  let appliedCount = 0;
  let newResults: EvalResult[];
  let newScore: number;
  let improved: boolean;
  try {
    appliedCount = await applyProposals(patches, ctx.instructionsPath);
    process.stdout.write(`Applied ${appliedCount}/${patches.length} patches to instructions.ts\n`);

    if (appliedCount === 0) {
      process.stdout.write('No patches matched current content. Stopping self-loop.\n');
      return { stop: true, currentResults, currentScore };
    }

    // Re-score.
    newResults = await ctx.runAndPrint('Re-running evals after patch...');
    newScore = scoreResults(newResults);
    improved = newScore > currentScore;
  } catch (err) {
    process.stderr.write(`Error during patch/eval: ${getMessage(err)}\n`);
    process.stdout.write('Reverting patches due to error.\n');
    await revertToSnapshot(snapshot, ctx.instructionsPath);
    return { stop: true, currentResults, currentScore };
  }

  process.stdout.write(formatScoreChangeLine(currentScore, newScore, improved));

  const result: IterationResult = {
    iteration,
    baselineScore: currentScore,
    newScore,
    proposalCount: patches.length,
    appliedCount,
    improved,
    reverted: !improved,
  };

  if (improved) {
    process.stdout.write('Score improved — keeping patches.\n\n');
    const allDone = newScore === 1;
    if (allDone) {
      process.stdout.write('All scenarios now pass! Self-loop complete.\n\n');
    }
    return { stop: allDone, pushResult: result, currentResults: newResults, currentScore: newScore };
  }

  process.stdout.write('Score did not improve — reverting patches.\n\n');
  await revertToSnapshot(snapshot, ctx.instructionsPath);
  // Stop after a non-improving iteration to avoid thrashing.
  return { stop: true, pushResult: result, currentResults, currentScore };
}

export interface SelfLoopCliArgs {
  maxIterations: number;
  dryRun: boolean;
  backend: string;
  scenarioFilter?: string;
  cliLogPath?: string;
  reflectionTimeoutMs: number;
}

const HELP_TEXT = `Usage: heimdall self-loop [options]

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
`;

/**
 * Parse `heimdall self-loop` CLI flags.
 * Exits the process (via requirePositiveInt, --help, or an unrecognized flag)
 * rather than returning when the arguments are invalid.
 */
export function parseSelfLoopArgs(args: string[]): SelfLoopCliArgs {
  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let dryRun = false;
  let backend = 'claude-cli';
  let scenarioFilter: string | undefined;
  let cliLogPath: string | undefined;
  let reflectionTimeoutMs = 180_000;

  for (let i = 0; i < args.length; i++) {
    const maxIterationsFlag = parseAliasedFlag(args, i, '--max-iterations', '-n');
    const backendFlag = parseAliasedFlag(args, i, '--backend', '-b');
    const scenarioFlag = parseAliasedFlag(args, i, '--scenario', '-s');
    const timeoutFlag = parseAliasedFlag(args, i, '--timeout');
    if (maxIterationsFlag) {
      maxIterations = parseInt(maxIterationsFlag.value, 10);
      requirePositiveInt(maxIterations, '--max-iterations must be a positive integer');
      i = maxIterationsFlag.nextIndex;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (backendFlag) {
      backend = backendFlag.value;
      i = backendFlag.nextIndex;
    } else if (scenarioFlag) {
      scenarioFilter = scenarioFlag.value;
      i = scenarioFlag.nextIndex;
    } else if ((args[i] === '--log-path' || args[i] === '-l') && args[i + 1]) {
      cliLogPath = args[++i];
    } else if (timeoutFlag) {
      const secs = parseInt(timeoutFlag.value, 10);
      requirePositiveInt(secs, '--timeout must be a positive integer (seconds)');
      reflectionTimeoutMs = secs * 1000;
      i = timeoutFlag.nextIndex;
    } else if (args[i] === '-h' || args[i] === '--help') {
      process.stdout.write(HELP_TEXT);
      process.exit(0);
    } else {
      process.stderr.write(`Error: unknown option '${args[i]}'\nRun with --help for usage.\n`);
      process.exit(1);
    }
  }

  return { maxIterations, dryRun, backend, scenarioFilter, cliLogPath, reflectionTimeoutMs };
}

async function main(): Promise<void> {
  const { maxIterations, dryRun, backend, scenarioFilter, cliLogPath, reflectionTimeoutMs } =
    parseSelfLoopArgs(process.argv.slice(2));

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
  const taskHistoryPath = resolveTaskHistoryFilePath(config.learning?.file, scenariosDir);
  const instructionsPath = resolve(__dirname, '..', 'src', 'lib', 'instructions.ts');
  const binPath = resolveBinPath(__dirname);

  const scenarios = await loadScenariosOrExit(scenariosDir, scenarioFilter);

  process.stdout.write(buildStartupBanner(maxIterations, backend, scenarios.length, dryRun));

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
  process.stdout.write(`Baseline score: ${formatPct(currentScore)} (${currentResults.filter(r => r.passed).length}/${currentResults.length} passed)\n\n`);

  if (currentScore === 1) {
    process.stdout.write('All scenarios already pass. Nothing to improve.\n');
    return;
  }

  const iterationCtx: IterationContext = {
    backend,
    reflectionTimeoutMs,
    dryRun,
    logPath,
    taskHistoryPath,
    instructionsPath,
    proposalsDir,
    runAndPrint,
    callLlmFn: callLlm,
  };

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    process.stdout.write(`--- Iteration ${iteration}/${maxIterations} ---\n`);

    const outcome = await runIteration(iteration, currentResults, currentScore, iterationCtx);
    if (outcome.pushResult) iterationHistory.push(outcome.pushResult);
    currentResults = outcome.currentResults;
    currentScore = outcome.currentScore;
    if (outcome.stop) break;
  }

  process.stdout.write(buildSummaryReport(iterationHistory, currentScore, logPath));
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`[heimdall-self-loop] Fatal error: ${getStackOrMessage(err)}\n`);
    process.exit(1);
  });
}
