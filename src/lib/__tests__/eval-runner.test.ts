/**
 * Tests for eval-runner.ts.
 *
 * Pure fs functions (loadScenario, loadScenarios, resolveBinPath) use real temp
 * dirs. runScenario is tested via a vi.mock on node:child_process so no real
 * binary is spawned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import {
  checkFinding,
  loadScenario,
  loadScenarios,
  resolveBinPath,
  runAllScenarios,
  runScenario,
  type EvalResult,
  type EvalScenario,
} from '../eval-runner.ts';

// ---------------------------------------------------------------------------
// Fake child process factory for runScenario / runAllScenarios tests
// ---------------------------------------------------------------------------

type FakeChildOptions = {
  stdoutData?: string;
  stderrData?: string;
  exitCode?: number;
  emitError?: Error;
};

function fakeChild({ stdoutData = '', stderrData = '', exitCode = 0, emitError }: FakeChildOptions = {}) {
  const childEmitter = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  setImmediate(() => {
    if (emitError) {
      childEmitter.emit('error', emitError);
    } else {
      if (stdoutData) stdout.emit('data', Buffer.from(stdoutData));
      if (stderrData) stderr.emit('data', Buffer.from(stderrData));
      childEmitter.emit('close', exitCode);
    }
  });

  return {
    stdout,
    stderr,
    kill: () => {},
    on: childEmitter.on.bind(childEmitter),
    once: childEmitter.once.bind(childEmitter),
  } as unknown as ReturnType<typeof spawn>;
}

const MINIMAL_SCENARIO: EvalScenario = {
  description: 'test scenario',
  prompt: 'check the cluster',
  mocks: {},
};

// ---------------------------------------------------------------------------
// checkFinding — pure assertion helper
// ---------------------------------------------------------------------------

type PartialFinding = { summary?: string; answer?: string; severity: string; suggestedCommands: string[] };
const finding = (overrides: Partial<PartialFinding> = {}): PartialFinding => ({
  summary: 'pod crashed',
  answer: 'oomkilled due to memory limit',
  severity: 'critical',
  suggestedCommands: [],
  ...overrides,
});

describe('checkFinding', () => {
  it('returns [] when finding is undefined (no assertions run)', () => {
    expect(checkFinding(undefined, { description: 'd', prompt: 'p', mocks: {} })).toEqual([]);
  });

  it('returns [] when no assertions are configured', () => {
    expect(checkFinding(finding() as never, { description: 'd', prompt: 'p', mocks: {} })).toEqual([]);
  });

  it('returns [] when severity matches expectedSeverity', () => {
    expect(checkFinding(finding({ severity: 'warning' }) as never, {
      description: 'd', prompt: 'p', mocks: {}, expectedSeverity: 'warning',
    })).toEqual([]);
  });

  it('returns a severity failure when severity does not match', () => {
    const failures = checkFinding(finding({ severity: 'info' }) as never, {
      description: 'd', prompt: 'p', mocks: {}, expectedSeverity: 'critical',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/severity/i);
    expect(failures[0]).toContain('"critical"');
    expect(failures[0]).toContain('"info"');
  });

  it('returns [] when all expectedKeywords are present', () => {
    expect(checkFinding(finding() as never, {
      description: 'd', prompt: 'p', mocks: {}, expectedKeywords: ['oomkilled', 'memory'],
    })).toEqual([]);
  });

  it('returns a failure for each missing expected keyword', () => {
    const failures = checkFinding(finding({ summary: 'all good', answer: 'running' }) as never, {
      description: 'd', prompt: 'p', mocks: {}, expectedKeywords: ['oomkill', 'memory'],
    });
    expect(failures).toHaveLength(2);
    expect(failures.some(f => f.includes('oomkill'))).toBe(true);
    expect(failures.some(f => f.includes('memory'))).toBe(true);
  });

  it('returns [] when no forbiddenKeyword is present', () => {
    expect(checkFinding(finding() as never, {
      description: 'd', prompt: 'p', mocks: {}, forbiddenKeywords: ['healthy'],
    })).toEqual([]);
  });

  it('returns a failure for each forbidden keyword found', () => {
    const failures = checkFinding(finding({ summary: 'healthy pod', answer: 'running fine' }) as never, {
      description: 'd', prompt: 'p', mocks: {}, forbiddenKeywords: ['healthy', 'fine'],
    });
    expect(failures).toHaveLength(2);
    expect(failures.some(f => f.includes('healthy'))).toBe(true);
    expect(failures.some(f => f.includes('fine'))).toBe(true);
  });

  it('keyword matching is case-insensitive', () => {
    expect(checkFinding(finding({ summary: 'OOMKILLED', answer: '' }) as never, {
      description: 'd', prompt: 'p', mocks: {}, expectedKeywords: ['oomkilled'],
    })).toEqual([]);
  });

  it('treats undefined summary and answer as empty strings (no crash)', () => {
    const failures = checkFinding(finding({ summary: undefined, answer: undefined }) as never, {
      description: 'd', prompt: 'p', mocks: {}, expectedKeywords: ['oomkilled'],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('oomkilled');
  });
});

// ---------------------------------------------------------------------------
// Temp dir shared by loadScenario / loadScenarios tests
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'heimdall-eval-test-'));
  (spawn as ReturnType<typeof vi.fn>).mockReset();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadScenario
// ---------------------------------------------------------------------------

describe('loadScenario', () => {
  it('loads a fully-specified valid scenario', async () => {
    const content = `
description: "OOMKill pod test"
prompt: "Why is the api pod OOMKilled?"
mocks:
  "get pods": "pod-1  OOMKilled"
  "describe pod": "OOMKilled reason"
expectedSeverity: warning
expectedKeywords:
  - oom
  - memory
forbiddenKeywords:
  - healthy
`.trimStart();
    const filePath = join(tmpDir, 'full.yaml');
    await writeFile(filePath, content);

    const scenario = await loadScenario(filePath);
    expect(scenario.description).toBe('OOMKill pod test');
    expect(scenario.prompt).toBe('Why is the api pod OOMKilled?');
    expect(scenario.mocks).toEqual({
      'get pods': 'pod-1  OOMKilled',
      'describe pod': 'OOMKilled reason',
    });
    expect(scenario.expectedSeverity).toBe('warning');
    expect(scenario.expectedKeywords).toEqual(['oom', 'memory']);
    expect(scenario.forbiddenKeywords).toEqual(['healthy']);
  });

  it('loads a minimal scenario with only required fields', async () => {
    const content = `description: "Minimal"\nprompt: "check the cluster"\n`;
    const filePath = join(tmpDir, 'minimal.yaml');
    await writeFile(filePath, content);

    const scenario = await loadScenario(filePath);
    expect(scenario.description).toBe('Minimal');
    expect(scenario.prompt).toBe('check the cluster');
    expect(scenario.mocks).toBeUndefined();
  });

  it('throws when the YAML is not an object (bare string)', async () => {
    const filePath = join(tmpDir, 'not-object.yaml');
    await writeFile(filePath, 'just a bare string');
    await expect(loadScenario(filePath)).rejects.toThrow(/invalid scenario file/i);
  });

  it('throws when the YAML is null / empty', async () => {
    const filePath = join(tmpDir, 'empty.yaml');
    await writeFile(filePath, '');
    await expect(loadScenario(filePath)).rejects.toThrow(/invalid scenario file/i);
  });

  it('throws when prompt is missing', async () => {
    const filePath = join(tmpDir, 'no-prompt.yaml');
    await writeFile(filePath, 'description: "no prompt here"\n');
    await expect(loadScenario(filePath)).rejects.toThrow(/missing required field "prompt"/i);
  });

  it('throws when prompt is an empty string', async () => {
    const filePath = join(tmpDir, 'empty-prompt.yaml');
    await writeFile(filePath, 'description: "d"\nprompt: ""\n');
    await expect(loadScenario(filePath)).rejects.toThrow(/missing required field "prompt"/i);
  });

  it('throws when description is missing', async () => {
    const filePath = join(tmpDir, 'no-desc.yaml');
    await writeFile(filePath, 'prompt: "some prompt"\n');
    await expect(loadScenario(filePath)).rejects.toThrow(/missing required field "description"/i);
  });

  it('throws when description is a non-string type (number)', async () => {
    const filePath = join(tmpDir, 'num-desc.yaml');
    await writeFile(filePath, 'description: 42\nprompt: "some prompt"\n');
    await expect(loadScenario(filePath)).rejects.toThrow(/missing required field "description"/i);
  });

  it('throws when mocks is an array instead of an object', async () => {
    const content = `
description: "arr mocks"
prompt: "some prompt"
mocks:
  - item1
  - item2
`.trimStart();
    const filePath = join(tmpDir, 'arr-mocks.yaml');
    await writeFile(filePath, content);
    await expect(loadScenario(filePath)).rejects.toThrow(/"mocks" must be an object/i);
  });

  it('throws when mocks is a bare string', async () => {
    const content = `description: "str mocks"\nprompt: "p"\nmocks: "not-an-object"\n`;
    const filePath = join(tmpDir, 'str-mocks.yaml');
    await writeFile(filePath, content);
    await expect(loadScenario(filePath)).rejects.toThrow(/"mocks" must be an object/i);
  });

  it('throws when mocks is null explicitly', async () => {
    const content = `description: "null mocks"\nprompt: "p"\nmocks: null\n`;
    const filePath = join(tmpDir, 'null-mocks.yaml');
    await writeFile(filePath, content);
    await expect(loadScenario(filePath)).rejects.toThrow(/"mocks" must be an object/i);
  });
});

// ---------------------------------------------------------------------------
// loadScenarios
// ---------------------------------------------------------------------------

describe('loadScenarios', () => {
  async function writeScenario(name: string, desc: string) {
    await writeFile(
      join(tmpDir, name),
      `description: "${desc}"\nprompt: "check ${desc}"\n`,
    );
  }

  it('returns an empty array for a directory with no YAML files', async () => {
    await writeFile(join(tmpDir, 'notes.txt'), 'not a scenario');
    const results = await loadScenarios(tmpDir);
    expect(results).toEqual([]);
  });

  it('loads all YAML files when no filter is given', async () => {
    await writeScenario('a.yaml', 'scenario-a');
    await writeScenario('b.yml', 'scenario-b');
    await writeFile(join(tmpDir, 'readme.txt'), 'ignored');

    const results = await loadScenarios(tmpDir);
    expect(results).toHaveLength(2);
    const descs = results.map(r => r.scenario.description).sort();
    expect(descs).toEqual(['scenario-a', 'scenario-b']);
  });

  it('filters by substring when filter is provided', async () => {
    await writeScenario('oom-crash.yaml', 'oom-crash');
    await writeScenario('network-timeout.yaml', 'network-timeout');

    const results = await loadScenarios(tmpDir, 'oom');
    expect(results).toHaveLength(1);
    expect(results[0].scenario.description).toBe('oom-crash');
  });

  it('throws when filter matches nothing', async () => {
    await writeScenario('oom.yaml', 'oom-test');
    await expect(loadScenarios(tmpDir, 'missing-pattern')).rejects.toThrow(/no scenario files matching/i);
  });

  it('returns all files when filter matches all', async () => {
    await writeScenario('oom-a.yaml', 'oom-a');
    await writeScenario('oom-b.yaml', 'oom-b');

    const results = await loadScenarios(tmpDir, 'oom');
    expect(results).toHaveLength(2);
  });

  it('includes the file path in each result', async () => {
    await writeScenario('crash.yaml', 'crash-test');
    const results = await loadScenarios(tmpDir);
    expect(results[0].path).toContain('crash.yaml');
  });
});

// ---------------------------------------------------------------------------
// resolveBinPath
// ---------------------------------------------------------------------------

describe('resolveBinPath', () => {
  it('resolves to <project-root>/bin/heimdall relative to a src/ subdirectory', () => {
    const srcDir = '/some/project/src/lib';
    const binPath = resolveBinPath(srcDir);
    expect(binPath).toBe(resolve('/some/project/src/lib', '..', 'bin', 'heimdall'));
  });

  it('produces an absolute path', () => {
    const binPath = resolveBinPath('/absolute/src/path');
    expect(isAbsolute(binPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runScenario (mocked spawn)
// ---------------------------------------------------------------------------

describe('runScenario', () => {
  it('resolves with passed=true for valid JSON output with no assertions', async () => {
    const finding = { summary: 'all pods healthy', answer: 'no issues', severity: 'info', suggestedCommands: [] };
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ stdoutData: JSON.stringify(finding) }),
    );

    const result = await runScenario('/bin/heimdall', MINIMAL_SCENARIO);

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.scenario).toBe('test scenario');
    expect(result.output?.severity).toBe('info');
  });

  it('passes when severity matches expectedSeverity', async () => {
    const finding = { summary: 'critical', answer: 'pod crashed', severity: 'critical', suggestedCommands: [] };
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ stdoutData: JSON.stringify(finding) }),
    );

    const result = await runScenario('/bin/heimdall', {
      ...MINIMAL_SCENARIO,
      expectedSeverity: 'critical',
    });

    expect(result.passed).toBe(true);
  });

  it('fails when severity does not match expectedSeverity', async () => {
    const finding = { summary: 'ok', answer: 'fine', severity: 'info', suggestedCommands: [] };
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ stdoutData: JSON.stringify(finding) }),
    );

    const result = await runScenario('/bin/heimdall', {
      ...MINIMAL_SCENARIO,
      expectedSeverity: 'critical',
    });

    expect(result.passed).toBe(false);
    expect(result.failures.some(f => f.toLowerCase().includes('severity'))).toBe(true);
  });

  it('passes when all expected keywords are present', async () => {
    const finding = { summary: 'pod oomkilled memory limit exceeded', answer: 'increase memory', severity: 'warning', suggestedCommands: [] };
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ stdoutData: JSON.stringify(finding) }),
    );

    const result = await runScenario('/bin/heimdall', {
      ...MINIMAL_SCENARIO,
      expectedKeywords: ['oomkilled', 'memory'],
    });

    expect(result.passed).toBe(true);
  });

  it('fails when an expected keyword is missing', async () => {
    const finding = { summary: 'pod running fine', answer: 'no issues', severity: 'info', suggestedCommands: [] };
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ stdoutData: JSON.stringify(finding) }),
    );

    const result = await runScenario('/bin/heimdall', {
      ...MINIMAL_SCENARIO,
      expectedKeywords: ['oomkill'],
    });

    expect(result.passed).toBe(false);
    expect(result.failures.some(f => f.includes('oomkill'))).toBe(true);
  });

  it('fails when a forbidden keyword is present in the output', async () => {
    const finding = { summary: 'pod is healthy and running', answer: 'no problems', severity: 'info', suggestedCommands: [] };
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ stdoutData: JSON.stringify(finding) }),
    );

    const result = await runScenario('/bin/heimdall', {
      ...MINIMAL_SCENARIO,
      forbiddenKeywords: ['healthy'],
    });

    expect(result.passed).toBe(false);
    expect(result.failures.some(f => f.includes('healthy'))).toBe(true);
  });

  it('passes when a forbidden keyword is absent from the output', async () => {
    const finding = { summary: 'pod crashed', answer: 'OOMKilled', severity: 'critical', suggestedCommands: [] };
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ stdoutData: JSON.stringify(finding) }),
    );

    const result = await runScenario('/bin/heimdall', {
      ...MINIMAL_SCENARIO,
      forbiddenKeywords: ['healthy'],
    });

    expect(result.passed).toBe(true);
  });

  it('fails when the process exits with a non-zero code', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ exitCode: 1, stderrData: 'agent process crashed' }),
    );

    const result = await runScenario('/bin/heimdall', MINIMAL_SCENARIO);

    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it('fails when the output is not valid JSON', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ stdoutData: 'this is not json' }),
    );

    const result = await runScenario('/bin/heimdall', MINIMAL_SCENARIO);

    expect(result.passed).toBe(false);
    expect(result.failures.some(f => /json/i.test(f))).toBe(true);
  });

  it('fails when the JSON output is not an object', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ stdoutData: '"just a string"' }),
    );

    const result = await runScenario('/bin/heimdall', MINIMAL_SCENARIO);

    expect(result.passed).toBe(false);
  });

  it('fails when spawn emits an error event', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ emitError: new Error('spawn ENOENT: heimdall not found') }),
    );

    const result = await runScenario('/bin/heimdall', MINIMAL_SCENARIO);

    expect(result.passed).toBe(false);
    expect(result.failures.some(f => f.includes('spawn ENOENT'))).toBe(true);
  });

  it('writes empty mock file when scenario.mocks is undefined', async () => {
    const scenarioNoMocks = { description: 'no mocks', prompt: 'check the cluster' } as EvalScenario;
    const finding = { summary: 'ok', answer: 'ok', severity: 'info', suggestedCommands: [] };
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ stdoutData: JSON.stringify(finding) }),
    );
    const result = await runScenario('/bin/heimdall', scenarioNoMocks);
    expect(result.passed).toBe(true);
  });

  it('uses stdout in error message when stderr is empty on non-zero exit', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ exitCode: 1, stdoutData: 'stdout-only error detail' }),
    );
    const result = await runScenario('/bin/heimdall', MINIMAL_SCENARIO);
    expect(result.passed).toBe(false);
    expect(result.failures.some(f => f.includes('stdout-only error detail'))).toBe(true);
  });

  it('handles finding with undefined summary and answer when checking keywords', async () => {
    const finding = { severity: 'warning', suggestedCommands: [] };
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ stdoutData: JSON.stringify(finding) }),
    );
    const result = await runScenario('/bin/heimdall', {
      ...MINIMAL_SCENARIO,
      expectedKeywords: ['oomkill'],
    });
    expect(result.passed).toBe(false);
    expect(result.failures.some(f => f.includes('oomkill'))).toBe(true);
  });

  it('handles non-Error value thrown by the child process error event', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const childEmitter = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      setImmediate(() => {
        childEmitter.emit('error', 'plain string error, not an Error instance');
      });
      return { stdout, stderr, kill: () => {}, on: childEmitter.on.bind(childEmitter), once: childEmitter.once.bind(childEmitter) } as unknown as ReturnType<typeof spawn>;
    });
    const result = await runScenario('/bin/heimdall', MINIMAL_SCENARIO);
    expect(result.passed).toBe(false);
    expect(result.failures.some(f => f.includes('plain string error'))).toBe(true);
  });

  it('settled guard ignores second resolve when close fires twice', async () => {
    const finding = { summary: 'ok', answer: 'ok', severity: 'info', suggestedCommands: [] };
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const childEmitter = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      setImmediate(() => {
        stdout.emit('data', Buffer.from(JSON.stringify(finding)));
        childEmitter.emit('close', 0);
        childEmitter.emit('close', 0); // second fire hits settled=true guard
      });
      return { stdout, stderr, kill: () => {}, on: childEmitter.on.bind(childEmitter), once: childEmitter.once.bind(childEmitter) } as unknown as ReturnType<typeof spawn>;
    });
    const result = await runScenario('/bin/heimdall', MINIMAL_SCENARIO);
    expect(result.passed).toBe(true);
  });

  it('settled guard ignores second reject when close fires twice with non-zero code', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const childEmitter = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      setImmediate(() => {
        stderr.emit('data', Buffer.from('error output'));
        childEmitter.emit('close', 1);
        childEmitter.emit('close', 1); // second fire hits settled=true guard
      });
      return { stdout, stderr, kill: () => {}, on: childEmitter.on.bind(childEmitter), once: childEmitter.once.bind(childEmitter) } as unknown as ReturnType<typeof spawn>;
    });
    const result = await runScenario('/bin/heimdall', MINIMAL_SCENARIO);
    expect(result.passed).toBe(false);
  });

  it('passes spawn --json and -p flags', async () => {
    let capturedArgs: string[] = [];
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce((_bin: string, args: string[]) => {
      capturedArgs = args;
      return fakeChild({ stdoutData: JSON.stringify({ summary: 'ok', answer: 'ok', severity: 'info', suggestedCommands: [] }) });
    });

    await runScenario('/bin/heimdall', { ...MINIMAL_SCENARIO, prompt: 'check pods' });

    expect(capturedArgs).toContain('-p');
    expect(capturedArgs).toContain('check pods');
    expect(capturedArgs).toContain('--json');
  });

  it('kills the child process and reports a timeout when timeoutMs elapses', async () => {
    let killCount = 0;

    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const childEmitter = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      // Never emit 'close' — simulates a hung process.
      return {
        stdout,
        stderr,
        kill: () => { killCount++; },
        on: childEmitter.on.bind(childEmitter),
        once: childEmitter.once.bind(childEmitter),
      } as unknown as ReturnType<typeof spawn>;
    });

    // Pass a short real timeout (50 ms) so the test completes without fake timers,
    // which avoids deadlocks between the fake clock and real I/O (writeFile/unlink).
    const result = await runScenario('/bin/heimdall', MINIMAL_SCENARIO, 50);
    expect(killCount).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => /timed out/i.test(f))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runAllScenarios — empty array and callbacks
// ---------------------------------------------------------------------------

describe('runAllScenarios', () => {
  it('returns an empty array when given no scenarios', async () => {
    const results = await runAllScenarios('/bin/heimdall', []);
    expect(results).toEqual([]);
  });

  it('does not invoke callbacks when there are no scenarios', async () => {
    let beforeCalled = false;
    let resultCalled = false;
    await runAllScenarios('/bin/heimdall', [], {
      onBefore: () => { beforeCalled = true; },
      onResult: () => { resultCalled = true; },
    });
    expect(beforeCalled).toBe(false);
    expect(resultCalled).toBe(false);
  });

  it('invokes onBefore and onResult for each scenario and accumulates results', async () => {
    const finding = { summary: 'ok', answer: 'ok', severity: 'info', suggestedCommands: [] };
    (spawn as ReturnType<typeof vi.fn>).mockImplementation(() =>
      fakeChild({ stdoutData: JSON.stringify(finding) }),
    );

    const beforeNames: string[] = [];
    const collectedResults: EvalResult[] = [];

    const scenarios = [
      { path: 'a.yaml', scenario: { description: 'scenario-a', prompt: 'check a', mocks: {} } },
      { path: 'b.yaml', scenario: { description: 'scenario-b', prompt: 'check b', mocks: {} } },
    ];

    const results = await runAllScenarios('/bin/heimdall', scenarios, {
      onBefore: name => beforeNames.push(name),
      onResult: r => collectedResults.push(r),
    });

    expect(results).toHaveLength(2);
    expect(beforeNames).toEqual(['scenario-a', 'scenario-b']);
    expect(collectedResults).toHaveLength(2);
    expect(collectedResults[0].scenario).toBe('scenario-a');
    expect(collectedResults[1].scenario).toBe('scenario-b');
  });
});
