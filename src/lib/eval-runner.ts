/**
 * Shared eval scenario runner for self-improve and self-loop modes.
 *
 * Extracted to avoid duplicating the spawn-and-assert logic across both
 * self-improve-mode.ts and self-loop-mode.ts.
 */
import { writeFile, unlink, readdir, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import type { OneShotFinding } from './format-output.ts';
import { getMessage } from './error-utils.ts';
import { spawnAndCollect } from './spawn-collect.ts';

export const EVAL_TIMEOUT_MS = 120_000;

export interface EvalScenario {
  description: string;
  mocks: Record<string, string>;
  prompt: string;
  expectedSeverity?: 'critical' | 'warning' | 'info';
  expectedKeywords?: string[];
  forbiddenKeywords?: string[];
}

export interface EvalResult {
  scenario: string;
  prompt: string;
  passed: boolean;
  failures: string[];
  output?: OneShotFinding;
}

function invalidScenario(filePath: string, detail: string): never {
  throw new Error(`Invalid scenario file: ${filePath} ${detail}`);
}

function requireField(
  parsed: Record<string, unknown>,
  field: 'prompt' | 'description',
  filePath: string,
  requireNonEmpty: boolean,
): void {
  const value = parsed[field];
  const invalid = typeof value !== 'string' || (requireNonEmpty && !value);
  if (invalid) {
    invalidScenario(filePath, `— missing required field "${field}"`);
  }
}

function requireOptionalArrayField(
  parsed: Record<string, unknown>,
  field: 'expectedKeywords' | 'forbiddenKeywords',
  filePath: string,
): void {
  if (parsed[field] !== undefined && !Array.isArray(parsed[field])) {
    invalidScenario(filePath, `— "${field}" must be an array if provided`);
  }
}

function requireOptionalObjectField(
  parsed: Record<string, unknown>,
  field: 'mocks',
  filePath: string,
): void {
  const value = parsed[field];
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    invalidScenario(filePath, `— "${field}" must be an object if provided`);
  }
}

export async function loadScenario(filePath: string): Promise<EvalScenario> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = loadYaml(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') {
    invalidScenario(filePath, 'is not a valid YAML object');
  }
  requireField(parsed, 'prompt', filePath, true);
  requireField(parsed, 'description', filePath, false);
  requireOptionalObjectField(parsed, 'mocks', filePath);
  requireOptionalArrayField(parsed, 'expectedKeywords', filePath);
  requireOptionalArrayField(parsed, 'forbiddenKeywords', filePath);
  return parsed as unknown as EvalScenario;
}

/**
 * Assert a parsed finding against scenario expectations.
 * Returns one failure string per violated assertion; returns [] when all pass.
 * Pure — no I/O, directly testable without spawning a process.
 */
export function checkFinding(
  finding: OneShotFinding | undefined,
  scenario: EvalScenario,
): string[] {
  if (!finding) return [];
  const failures: string[] = [];

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

  return failures;
}

export async function runScenario(
  binPath: string,
  scenario: EvalScenario,
  timeoutMs = EVAL_TIMEOUT_MS,
): Promise<EvalResult> {
  const tmpFile = join(tmpdir(), `heimdall-eval-${randomBytes(8).toString('hex')}.json`);
  await writeFile(tmpFile, JSON.stringify(scenario.mocks ?? {}), 'utf8');

  const failures: string[] = [];
  let finding: OneShotFinding | undefined;

  try {
    const rawOutput = await spawnAndCollect(
      binPath,
      ['-p', scenario.prompt, '--json'],
      {
        env: { ...process.env, HEIMDALL_KUBECTL_MOCK: tmpFile, HEIMDALL_EVAL_MODE: '1' },
        timeoutMs,
        onTimeout: () => new Error(`scenario timed out after ${timeoutMs / 1000}s`),
        onExit: (code, _signal, stdout, stderr) =>
          code !== 0 ? new Error(`agent exited with code ${code}: ${stderr || stdout}`) : null,
      },
    );

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

    failures.push(...checkFinding(finding, scenario));
  } catch (err) {
    failures.push(`Agent error: ${getMessage(err)}`);
  } finally {
    try { await unlink(tmpFile); } catch { /* ignore */ }
  }

  return {
    scenario: scenario.description,
    prompt: scenario.prompt,
    passed: failures.length === 0,
    failures,
    output: finding,
  };
}

export async function loadScenarios(
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
  return Promise.all(
    matched.map(async file => {
      const filePath = join(scenariosDir, file);
      const scenario = await loadScenario(filePath);
      return { path: filePath, scenario };
    }),
  );
}

/**
 * Load scenarios for a CLI entry point, printing the same error and exiting(1)
 * on a load failure or an empty result — shared by eval-mode, self-improve-mode,
 * and self-loop-mode so the three don't drift out of sync.
 */
export async function loadScenariosOrExit(
  scenariosDir: string,
  filter?: string,
): Promise<Array<{ path: string; scenario: EvalScenario }>> {
  try {
    const scenarios = await loadScenarios(scenariosDir, filter);
    if (scenarios.length === 0) {
      process.stderr.write(`No scenario files found in ${scenariosDir}\n`);
      process.exit(1);
    }
    return scenarios;
  } catch (err) {
    process.stderr.write(`Error loading scenarios: ${getMessage(err)}\n`);
    process.exit(1);
  }
}

export interface RunCallbacks {
  onBefore?: (scenarioName: string) => void;
  onResult?: (result: EvalResult) => void;
}

export async function runAllScenarios(
  binPath: string,
  scenarios: Array<{ path: string; scenario: EvalScenario }>,
  callbacks: RunCallbacks = {},
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const { scenario } of scenarios) {
    callbacks.onBefore?.(scenario.description);
    const result = await runScenario(binPath, scenario);
    results.push(result);
    callbacks.onResult?.(result);
  }
  return results;
}
