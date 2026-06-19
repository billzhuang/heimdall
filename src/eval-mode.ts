/**
 * Heimdall eval mode.
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
import { spawn } from 'node:child_process';
import { writeFile, unlink, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import type { OneShotFinding } from './lib/format-output.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EVAL_TIMEOUT_MS = 120_000; // 2 minutes per scenario

export interface EvalScenario {
  description: string;
  mocks: Record<string, string>;
  prompt: string;
  expectedSeverity?: 'critical' | 'warning' | 'info';
  expectedKeywords?: string[];
  forbiddenKeywords?: string[];
}

interface EvalResult {
  scenario: string;
  passed: boolean;
  failures: string[];
  output?: OneShotFinding;
}

/** Load a YAML file and parse it as an EvalScenario. */
async function loadScenario(filePath: string): Promise<EvalScenario> {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(filePath, 'utf8');
  return loadYaml(raw) as EvalScenario;
}

/** Run a single scenario: spawn the agent, parse output, check assertions. */
async function runScenario(scenarioPath: string, scenario: EvalScenario): Promise<EvalResult> {
  // Write mock fixtures to a uniquely-named temp file.
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
        env: {
          ...process.env,
          HEIMDALL_KUBECTL_MOCK: tmpFile,
        },
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
          if (code !== 0 && !out) {
            const errOut = Buffer.concat(errChunks).toString('utf8').trim();
            reject(new Error(`agent exited with code ${code}: ${errOut}`));
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

    // Parse JSON output from the agent.
    try {
      finding = JSON.parse(rawOutput) as OneShotFinding;
    } catch {
      failures.push(`Failed to parse JSON output: ${rawOutput.slice(0, 200)}`);
    }

    if (finding) {
      // Check severity.
      if (scenario.expectedSeverity && finding.severity !== scenario.expectedSeverity) {
        failures.push(`Severity: expected "${scenario.expectedSeverity}", got "${finding.severity}"`);
      }

      // Check expected keywords (case-insensitive) anywhere in answer or summary.
      const fullText = `${finding.summary} ${finding.answer}`.toLowerCase();
      for (const kw of scenario.expectedKeywords ?? []) {
        if (!fullText.includes(kw.toLowerCase())) {
          failures.push(`Missing expected keyword: "${kw}"`);
        }
      }

      // Check forbidden keywords.
      for (const kw of scenario.forbiddenKeywords ?? []) {
        if (fullText.includes(kw.toLowerCase())) {
          failures.push(`Found forbidden keyword: "${kw}"`);
        }
      }
    }
  } catch (err) {
    failures.push(`Agent error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Clean up temp file.
    try {
      await unlink(tmpFile);
    } catch {
      // Ignore cleanup errors.
    }
  }

  return {
    scenario: scenario.description,
    passed: failures.length === 0,
    failures,
    output: finding,
  };
}

/** Load all scenario YAML files from the scenarios directory. */
async function loadScenarios(scenariosDir: string, filter?: string): Promise<Array<{ path: string; scenario: EvalScenario }>> {
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

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--scenario' || args[i] === '-s') && args[i + 1]) {
      scenarioFilter = args[++i];
    } else if (args[i].startsWith('--scenario=')) {
      scenarioFilter = args[i].slice('--scenario='.length);
    } else if (args[i] === '-h' || args[i] === '--help') {
      process.stdout.write(`Usage: heimdall eval [--scenario <name-substring>]

Run synthetic RCA evaluation scenarios against the Heimdall agent.
No real cluster is needed — kubectl responses are mocked.

Options:
  --scenario, -s <name>   Run only scenarios whose filename contains <name>
  -h, --help              Show this help message

Examples:
  heimdall eval                       # run all scenarios
  heimdall eval --scenario crashloop  # run only the CrashLoop scenario
  npm run eval
`);
      process.exit(0);
    }
  }

  const scenariosDir = resolve(__dirname, '..', 'scenarios');

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

  process.stdout.write(`\nRunning ${scenarios.length} eval scenario${scenarios.length === 1 ? '' : 's'}...\n\n`);

  const results: EvalResult[] = [];
  for (const { path: scenarioPath, scenario } of scenarios) {
    const name = scenario.description;
    process.stdout.write(`  Running: ${name}\n`);
    const result = await runScenario(scenarioPath, scenario);
    results.push(result);

    if (result.passed) {
      process.stdout.write(`  ✓ PASS  ${name}\n`);
    } else {
      process.stdout.write(`  ✗ FAIL  ${name}\n`);
      for (const failure of result.failures) {
        process.stdout.write(`         - ${failure}\n`);
      }
    }
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;

  process.stdout.write(`\nResults: ${passed} passed, ${failed} failed out of ${results.length} scenarios\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[heimdall-eval] Fatal error: ${detail}\n`);
  process.exit(1);
});
