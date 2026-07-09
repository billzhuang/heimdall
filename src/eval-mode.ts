/**
 * Heimdall eval mode CLI entry point.
 *
 * Runs synthetic RCA scenarios against the Heimdall agent without a real
 * cluster. kubectl responses are mocked via the HEIMDALL_KUBECTL_MOCK env var,
 * injected as a temp JSON file into a subprocess running `bin/heimdall --json`.
 *
 * Usage:
 *   npm run eval
 *   npm run eval -- --scenario crashloop
 *   heimdall eval
 *   heimdall eval --scenario oom
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadScenariosOrExit,
  runAllScenarios,
  type EvalScenario,
  type EvalResult,
} from './lib/eval-runner.ts';
import { resolveBinPath } from './lib/bin-path.ts';
import { getStackOrMessage } from './lib/error-utils.ts';
import { parseModelFlag, parseAliasedFlag, isMainModule, resolveModelOrExit } from './lib/cli-args.ts';

export type { EvalScenario, EvalResult };

const __dirname = dirname(fileURLToPath(import.meta.url));

const HELP_TEXT = `Usage: heimdall eval [--scenario <name-substring>]

Run synthetic RCA evaluation scenarios against the Heimdall agent.
No real cluster is needed — kubectl responses are mocked.

Options:
  --scenario, -s <name>       Run only scenarios whose filename contains <name>
  --model <provider/model>    Override the LLM model
  -h, --help                  Show this help message

Examples:
  heimdall eval                       # run all scenarios
  heimdall eval --scenario crashloop  # run only the CrashLoop scenario
  npm run eval
`;

export interface EvalCliArgs {
  scenarioFilter?: string;
  modelFlag?: string;
  help: boolean;
}

/** Parse `heimdall eval` CLI flags. Unrecognized flags are silently ignored. */
export function parseEvalArgs(args: string[]): EvalCliArgs {
  let scenarioFilter: string | undefined;
  let modelFlag: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const scenarioFlag = parseAliasedFlag(args, i, '--scenario', '-s');
    if (scenarioFlag) {
      scenarioFilter = scenarioFlag.value;
      i = scenarioFlag.nextIndex;
    } else if (args[i] === '--model' || args[i] === '-m' || args[i].startsWith('--model=')) {
      const parsed = parseModelFlag(args, i, ['--model', '-m']);
      modelFlag = parsed.value;
      i = parsed.nextIndex;
    } else if (args[i] === '-h' || args[i] === '--help') {
      return { scenarioFilter, modelFlag, help: true };
    }
  }

  return { scenarioFilter, modelFlag, help: false };
}

async function main(): Promise<void> {
  const { scenarioFilter, modelFlag, help } = parseEvalArgs(process.argv.slice(2));

  if (help) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  const scenariosDir = resolve(__dirname, '..', 'scenarios');
  const binPath = resolveBinPath(__dirname);

  const resolvedModel = resolveModelOrExit(modelFlag);
  process.env.HEIMDALL_MODEL = resolvedModel;

  const scenarios = await loadScenariosOrExit(scenariosDir, scenarioFilter);

  process.stdout.write(`\nRunning ${scenarios.length} eval scenario${scenarios.length === 1 ? '' : 's'}...\n\n`);

  const results = await runAllScenarios(binPath, scenarios, {
    onBefore: name => process.stdout.write(`  Running: ${name}\n`),
    onResult: result => {
      if (result.passed) {
        process.stdout.write(`  ✓ PASS  ${result.scenario}\n`);
      } else {
        process.stdout.write(`  ✗ FAIL  ${result.scenario}\n`);
        for (const failure of result.failures) {
          process.stdout.write(`         - ${failure}\n`);
        }
      }
    },
  });

  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;

  process.stdout.write(`\nResults: ${passed} passed, ${failed} failed out of ${results.length} scenarios\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`[heimdall-eval] Fatal error: ${getStackOrMessage(err)}\n`);
    process.exit(1);
  });
}
