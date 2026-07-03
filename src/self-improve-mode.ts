/**
 * Heimdall self-improve mode.
 *
 * Runs synthetic eval scenarios, captures assertion failures as structured
 * learning entries (scenarios/learning-log.jsonl), and optionally prints a
 * reflection prompt for proposing concrete changes to src/lib/instructions.ts.
 *
 * Inspired by Karpathy's self-research loop and loop-engineer patterns:
 * run → evaluate → learn → improve → repeat.
 *
 * Usage:
 *   heimdall self-improve
 *   heimdall self-improve --scenario crashloop
 *   heimdall self-improve --reflect
 *   heimdall self-improve --reflect --from-log
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadScenarios,
  runScenario,
  type EvalResult,
} from './lib/eval-runner.ts';
import { resolveBinPath } from './lib/bin-path.ts';
import {
  buildLearningEntry,
  appendLearningEntry,
  readLearningLog,
  buildReflectionPrompt,
  resolveLogPath,
  resolveRagOptions,
  type LearningEntry,
} from './lib/self-improve.ts';
import { readTaskHistory, type TaskHistoryEntry } from './lib/task-history.ts';
import { loadConfig } from './lib/config.ts';
import { getMessage, getStackOrMessage } from './lib/error-utils.ts';
import { isMainModule } from './lib/cli-args.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LEARNING_LOG_NAME = 'learning-log.jsonl';
const TASK_HISTORY_NAME = 'task-history.jsonl';

const HELP_TEXT = `Usage: heimdall self-improve [--scenario <name>] [--reflect] [--from-log] [--log-path <path>] [--log-stdout]

Run eval scenarios and record failures as structured learning entries.

Options:
  --scenario, -s <name>  Run only scenarios whose filename contains <name>
  --reflect              After running, print a meta-prompt for instruction improvements
  --from-log             Reflect on existing learning-log.jsonl instead of running new evals
  --log-path, -l <path>  Write the learning log to <path> instead of the default location
  --log-stdout           Emit learning entries as JSONL to stdout (no file written)
  -h, --help             Show this help message

Log path resolution order (highest to lowest priority):
  1. --log-path <path>
  2. HEIMDALL_LEARNING_LOG environment variable
  3. learning.logFile in heimdall.config.yaml
  4. Default: scenarios/learning-log.jsonl (relative to the Heimdall package root)

In container or lambda deployments the local filesystem is ephemeral. Use one of:
  - Mount a persistent volume and set HEIMDALL_LEARNING_LOG=/mnt/volume/learning-log.jsonl
  - Set learning.logFile in heimdall.config.yaml to an absolute path on a mounted volume
  - Use --log-stdout to emit entries to stdout for aggregation by the container log driver

Examples:
  heimdall self-improve                                          # run all scenarios, record failures
  heimdall self-improve --reflect                               # run evals + print reflection prompt
  heimdall self-improve --reflect --from-log                    # reflect on prior failures in the log
  heimdall self-improve --scenario crashloop                    # run only matching scenarios
  heimdall self-improve --log-path /mnt/efs/learning-log.jsonl  # write log to persistent volume
  heimdall self-improve --log-stdout                            # emit JSONL entries to stdout
  HEIMDALL_LEARNING_LOG=/mnt/data/log.jsonl heimdall self-improve
`;

export interface SelfImproveCliArgs {
  scenarioFilter?: string;
  reflect: boolean;
  fromLog: boolean;
  cliLogPath?: string;
  logStdout: boolean;
}

/**
 * Parse `heimdall self-improve` CLI flags.
 * Exits the process (via --help) rather than returning when help is requested.
 * Unrecognized flags are silently ignored, matching this mode's historical behavior.
 */
export function parseSelfImproveArgs(args: string[]): SelfImproveCliArgs {
  let scenarioFilter: string | undefined;
  let reflect = false;
  let fromLog = false;
  let cliLogPath: string | undefined;
  let logStdout = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--scenario' || args[i] === '-s') && args[i + 1]) {
      scenarioFilter = args[++i];
    } else if (args[i].startsWith('--scenario=')) {
      scenarioFilter = args[i].slice('--scenario='.length);
    } else if (args[i] === '--reflect') {
      reflect = true;
    } else if (args[i] === '--from-log') {
      fromLog = true;
    } else if ((args[i] === '--log-path' || args[i] === '-l') && args[i + 1]) {
      cliLogPath = args[++i];
    } else if (args[i].startsWith('--log-path=')) {
      cliLogPath = args[i].slice('--log-path='.length);
    } else if (args[i] === '--log-stdout') {
      logStdout = true;
    } else if (args[i] === '-h' || args[i] === '--help') {
      process.stdout.write(HELP_TEXT);
      process.exit(0);
    }
  }

  return { scenarioFilter, reflect, fromLog, cliLogPath, logStdout };
}

/** Print the reflection-prompt banner used by both the failure and all-passed flows. */
function printReflectionPrompt(
  entries: LearningEntry[],
  taskHistory: TaskHistoryEntry[],
  useRag: boolean,
  ragTopK: number,
): void {
  process.stdout.write('\n' + '='.repeat(60) + '\n');
  process.stdout.write(
    'Reflection prompt (paste into any LLM to get targeted instruction improvements):\n',
  );
  process.stdout.write('='.repeat(60) + '\n\n');
  process.stdout.write(buildReflectionPrompt(entries, taskHistory, useRag, ragTopK) + '\n\n');
  process.stdout.write('='.repeat(60) + '\n');
}

async function main(): Promise<void> {
  const { scenarioFilter, reflect, fromLog, cliLogPath, logStdout } =
    parseSelfImproveArgs(process.argv.slice(2));

  const scenariosDir = resolve(__dirname, '..', 'scenarios');
  const config = loadConfig();
  const logPath = resolveLogPath(cliLogPath, config.learning?.logFile, join(scenariosDir, LEARNING_LOG_NAME));
  const taskHistoryPath = config.learning?.file
    ? resolve(config.learning.file)
    : join(scenariosDir, TASK_HISTORY_NAME);
  const { useRag, ragTopK } = resolveRagOptions(config.learning);

  // --from-log: skip running evals; reflect on existing log entries instead.
  if (fromLog) {
    if (!reflect) {
      process.stderr.write('--from-log requires --reflect\n');
      process.exit(1);
    }
    const [entries, taskHistory] = await Promise.all([
      readLearningLog(logPath),
      readTaskHistory(taskHistoryPath),
    ]);
    if (entries.length === 0 && taskHistory.length === 0) {
      process.stdout.write(
        `No entries found in ${logPath} or ${taskHistoryPath}.\nRun without --from-log first to generate learning entries.\n`,
      );
      process.exit(0);
    }
    process.stdout.write(
      `\nReflecting on ${entries.length} eval entr${entries.length === 1 ? 'y' : 'ies'} and ` +
      `${taskHistory.length} task history entr${taskHistory.length === 1 ? 'y' : 'ies'}...\n\n`,
    );
    process.stdout.write('='.repeat(60) + '\n');
    process.stdout.write(buildReflectionPrompt(entries, taskHistory, useRag, ragTopK) + '\n');
    process.stdout.write('='.repeat(60) + '\n');
    return;
  }

  // Normal flow: run eval scenarios and record any failures.
  let scenarios: Awaited<ReturnType<typeof loadScenarios>>;
  try {
    scenarios = await loadScenarios(scenariosDir, scenarioFilter);
  } catch (err) {
    process.stderr.write(
      `Error loading scenarios: ${getMessage(err)}\n`,
    );
    process.exit(1);
  }

  if (scenarios.length === 0) {
    process.stderr.write(`No scenario files found in ${scenariosDir}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `\nRunning ${scenarios.length} eval scenario${scenarios.length === 1 ? '' : 's'} (self-improve mode)...\n\n`,
  );

  const binPath = resolveBinPath(__dirname);
  const results: EvalResult[] = [];
  for (const { scenario } of scenarios) {
    process.stdout.write(`  Running: ${scenario.description}\n`);
    const result = await runScenario(binPath, scenario);
    results.push(result);

    if (result.passed) {
      process.stdout.write(`  ✓ PASS  ${result.scenario}\n`);
    } else {
      process.stdout.write(`  ✗ FAIL  ${result.scenario}\n`);
      for (const failure of result.failures) {
        process.stdout.write(`         - ${failure}\n`);
      }
    }
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;

  process.stdout.write(
    `\nResults: ${passed} passed, ${failed} failed out of ${results.length} scenarios\n`,
  );

  // Append a learning entry for every failing scenario.
  const failedResults = results.filter(r => !r.passed);
  if (failedResults.length > 0) {
    const learningEntries = failedResults.map(r =>
      buildLearningEntry(r.scenario, r.prompt, r.failures),
    );
    if (logStdout) {
      process.stdout.write('\n=== LEARNING ENTRIES (JSONL) ===\n');
      for (const entry of learningEntries) {
        process.stdout.write(JSON.stringify(entry) + '\n');
      }
      process.stdout.write('=== END LEARNING ENTRIES ===\n');
    } else {
      for (const entry of learningEntries) {
        await appendLearningEntry(entry, logPath);
      }
      process.stdout.write(
        `\n${failedResults.length} learning entr${failedResults.length === 1 ? 'y' : 'ies'} written to ${logPath}\n`,
      );
    }

    if (reflect) {
      const taskHistory = await readTaskHistory(taskHistoryPath);
      printReflectionPrompt(learningEntries, taskHistory, useRag, ragTopK);
    } else {
      process.stdout.write(
        `\nTip: run with --reflect to generate a meta-prompt for instruction improvements.\n`,
      );
    }
  } else {
    process.stdout.write(
      '\nAll scenarios passed — no learning entries added. Keep up the good work!\n',
    );
    if (reflect) {
      const taskHistory = await readTaskHistory(taskHistoryPath);
      if (taskHistory.length > 0) {
        printReflectionPrompt([], taskHistory, useRag, ragTopK);
      }
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`[heimdall-self-improve] Fatal error: ${getStackOrMessage(err)}\n`);
    process.exit(1);
  });
}
