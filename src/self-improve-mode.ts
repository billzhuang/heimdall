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
import { spawn } from 'node:child_process';
import { writeFile, unlink, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import type { OneShotFinding } from './lib/format-output.ts';
import {
  buildLearningEntry,
  appendLearningEntry,
  readLearningLog,
  buildReflectionPrompt,
} from './lib/self-improve.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EVAL_TIMEOUT_MS = 120_000;
const LEARNING_LOG_NAME = 'learning-log.jsonl';

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
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(filePath, 'utf8');
  const parsed = loadYaml(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid scenario file: ${filePath} is not a valid YAML object`);
  }
  return parsed as EvalScenario;
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
      const settle = (err?: Error) => {
        if (!settled) {
          settled = true;
          if (err) reject(err);
        }
      };

      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];

      const child = spawn(binPath, ['-p', scenario.prompt, '--json'], {
        env: { ...process.env, HEIMDALL_KUBECTL_MOCK: tmpFile },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        settle(new Error(`scenario timed out after ${EVAL_TIMEOUT_MS / 1000}s`));
        reject(new Error(`scenario timed out after ${EVAL_TIMEOUT_MS / 1000}s`));
      }, EVAL_TIMEOUT_MS);

      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          const out = Buffer.concat(chunks).toString('utf8').trim();
          if (code !== 0) {
            const errOut = Buffer.concat(errChunks).toString('utf8').trim();
            reject(new Error(`agent exited with code ${code}: ${errOut || out}`));
          } else {
            resolve(out);
          }
        }
      });

      child.on('error', (err: Error) => {
        clearTimeout(timer);
        settle(err);
        reject(err);
      });
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
    try {
      await unlink(tmpFile);
    } catch {
      // Ignore cleanup errors.
    }
  }

  return {
    scenario: scenario.description,
    prompt: scenario.prompt,
    passed: failures.length === 0,
    failures,
    output: finding,
  };
}

async function loadScenarios(
  scenariosDir: string,
  filter?: string,
): Promise<Array<{ path: string; scenario: EvalScenario }>> {
  const files = await readdir(scenariosDir);
  const yamlFiles = files.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

  const matched = filter
    ? yamlFiles.filter(f => f.toLowerCase().includes(filter.toLowerCase()))
    : yamlFiles;

  if (matched.length === 0 && filter) {
    throw new Error(`No scenario files matching "${filter}" found in ${scenariosDir}`);
  }

  const results: Array<{ path: string; scenario: EvalScenario }> = [];
  for (const file of matched) {
    const filePath = join(scenariosDir, file);
    const scenario = await loadScenario(filePath);
    results.push({ path: filePath, scenario });
  }
  return results;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let scenarioFilter: string | undefined;
  let reflect = false;
  let fromLog = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--scenario' || args[i] === '-s') && args[i + 1]) {
      scenarioFilter = args[++i];
    } else if (args[i].startsWith('--scenario=')) {
      scenarioFilter = args[i].slice('--scenario='.length);
    } else if (args[i] === '--reflect') {
      reflect = true;
    } else if (args[i] === '--from-log') {
      fromLog = true;
    } else if (args[i] === '-h' || args[i] === '--help') {
      process.stdout.write(`Usage: heimdall self-improve [--scenario <name>] [--reflect] [--from-log]

Run eval scenarios and record failures as structured learning entries.

Options:
  --scenario, -s <name>  Run only scenarios whose filename contains <name>
  --reflect              After running, print a meta-prompt for instruction improvements
  --from-log             Reflect on existing learning-log.jsonl instead of running new evals
  -h, --help             Show this help message

The learning log is written to scenarios/learning-log.jsonl.
Review it after each run to track what the agent is getting wrong and why.

Examples:
  heimdall self-improve                       # run all scenarios, record failures
  heimdall self-improve --reflect             # run evals + print reflection prompt
  heimdall self-improve --reflect --from-log  # reflect on prior failures in the log
  heimdall self-improve --scenario crashloop  # run only matching scenarios
`);
      process.exit(0);
    }
  }

  const scenariosDir = resolve(__dirname, '..', 'scenarios');
  const logPath = join(scenariosDir, LEARNING_LOG_NAME);

  // --from-log: skip running evals; reflect on existing log entries instead.
  if (fromLog) {
    if (!reflect) {
      process.stderr.write('--from-log requires --reflect\n');
      process.exit(1);
    }
    const entries = await readLearningLog(logPath);
    if (entries.length === 0) {
      process.stdout.write(
        `No entries found in ${logPath}.\nRun without --from-log first to generate learning entries.\n`,
      );
      process.exit(0);
    }
    process.stdout.write(`\nReflecting on ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} from the learning log...\n\n`);
    process.stdout.write('='.repeat(60) + '\n');
    process.stdout.write(buildReflectionPrompt(entries) + '\n');
    process.stdout.write('='.repeat(60) + '\n');
    return;
  }

  // Normal flow: run eval scenarios and record any failures.
  let scenarios: Array<{ path: string; scenario: EvalScenario }>;
  try {
    scenarios = await loadScenarios(scenariosDir, scenarioFilter);
  } catch (err) {
    process.stderr.write(
      `Error loading scenarios: ${err instanceof Error ? err.message : String(err)}\n`,
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

  const results: EvalResult[] = [];
  for (const { path: scenarioPath, scenario } of scenarios) {
    process.stdout.write(`  Running: ${scenario.description}\n`);
    const result = await runScenario(scenarioPath, scenario);
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
    for (const entry of learningEntries) {
      await appendLearningEntry(entry, logPath);
    }
    process.stdout.write(
      `\n${failedResults.length} learning entr${failedResults.length === 1 ? 'y' : 'ies'} written to ${logPath}\n`,
    );

    if (reflect) {
      process.stdout.write('\n' + '='.repeat(60) + '\n');
      process.stdout.write(
        'Reflection prompt (paste into any LLM to get targeted instruction improvements):\n',
      );
      process.stdout.write('='.repeat(60) + '\n\n');
      process.stdout.write(buildReflectionPrompt(learningEntries) + '\n\n');
      process.stdout.write('='.repeat(60) + '\n');
    } else {
      process.stdout.write(
        `\nTip: run with --reflect to generate a meta-prompt for instruction improvements.\n`,
      );
    }
  } else {
    process.stdout.write(
      '\nAll scenarios passed — no learning entries added. Keep up the good work!\n',
    );
  }
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[heimdall-self-improve] Fatal error: ${detail}\n`);
  process.exit(1);
});
