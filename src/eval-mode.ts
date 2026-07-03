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
  loadScenarios,
  runAllScenarios,
  type EvalScenario,
  type EvalResult,
} from './lib/eval-runner.ts';
import { resolveBinPath } from './lib/bin-path.ts';
import { resolveModel } from './lib/model.ts';
import { getMessage, getStackOrMessage } from './lib/error-utils.ts';

export type { EvalScenario, EvalResult };

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let scenarioFilter: string | undefined;
  let modelFlag: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--scenario' || args[i] === '-s') && args[i + 1]) {
      scenarioFilter = args[++i];
    } else if (args[i].startsWith('--scenario=')) {
      scenarioFilter = args[i].slice('--scenario='.length);
    } else if (args[i] === '--model' || args[i] === '-m') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) {
        process.stderr.write(`Error: ${args[i]} requires a value\n`);
        process.exit(1);
      }
      modelFlag = args[++i];
    } else if (args[i].startsWith('--model=')) {
      const m = args[i].slice('--model='.length);
      if (!m) {
        process.stderr.write(`Error: --model= requires a non-empty value\n`);
        process.exit(1);
      }
      modelFlag = m;
    } else if (args[i] === '-h' || args[i] === '--help') {
      process.stdout.write(`Usage: heimdall eval [--scenario <name-substring>]

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
`);
      process.exit(0);
    }
  }

  const scenariosDir = resolve(__dirname, '..', 'scenarios');
  const binPath = resolveBinPath(__dirname);

  let resolvedModel: string;
  try {
    resolvedModel = resolveModel(modelFlag);
  } catch (err) {
    process.stderr.write(`Error: ${getMessage(err)}\n`);
    process.exit(1);
  }
  process.env.HEIMDALL_MODEL = resolvedModel;

  let scenarios: Array<{ path: string; scenario: EvalScenario }>;
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

  process.stdout.write(`\nRunning ${scenarios.length} eval scenario${scenarios.length === 1 ? '' : 's'}...\n\n`);

  const results: EvalResult[] = await runAllScenarios(binPath, scenarios, {
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

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    process.stderr.write(`[heimdall-eval] Fatal error: ${getStackOrMessage(err)}\n`);
    process.exit(1);
  });
}
