import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setOutput,
  appendSummary,
  capture,
  readActionConfig,
  checkFailOnSeverity,
  runPromptMode,
  runTriageMode,
  runScheduleOnceMode,
  main,
  type ActionConfig,
} from '../github-action-runner.ts';
import {
  evaluateFailOn,
  VALID_FAIL_ON_SEVERITIES,
} from '../github-action.ts';
import type { OneShotFinding } from '../format-output.ts';

// Increase listener limit to avoid MaxListenersExceededWarning when multiple
// process.exit spies and child-process cleanup handlers coexist during parallel
// test execution.
beforeAll(() => {
  process.setMaxListeners(50);
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const FINDING: OneShotFinding = {
  summary: 'Pod crash-looping due to OOMKill',
  answer: 'The pod is repeatedly restarting due to exceeding its memory limit.',
  severity: 'critical',
  suggestedCommands: ['kubectl describe pod api-server-xyz'],
  remediationSteps: ['Increase memory limit to 512Mi'],
};

function makeConfig(overrides: Partial<ActionConfig> = {}): ActionConfig {
  return {
    mode: 'prompt',
    prompt: 'Why is my pod crashing?',
    namespace: '',
    allNamespaces: false,
    failOn: '',
    postSummary: false,
    githubOutput: '',
    githubStepSummary: '',
    ...overrides,
  };
}

/** Stub process.exit so tests don't actually exit — throws instead. */
function stubExit() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as typeof process.exit);
}

afterEach(() => {
  vi.restoreAllMocks();
  // Clean up env vars set by readActionConfig tests.
  for (const key of [
    '_HEIMDALL_ACTION_MODE',
    '_HEIMDALL_ACTION_PROMPT',
    '_HEIMDALL_ACTION_NAMESPACE',
    '_HEIMDALL_ACTION_ALL_NAMESPACES',
    '_HEIMDALL_ACTION_FAIL_ON',
    '_HEIMDALL_ACTION_POST_SUMMARY',
    'GITHUB_OUTPUT',
    'GITHUB_STEP_SUMMARY',
  ]) {
    delete process.env[key];
  }
});

// ── evaluateFailOn (re-exported via github-action.ts) ──────────────────────

describe('evaluateFailOn', () => {
  it('returns ok when failOn is empty string', () => {
    expect(evaluateFailOn('', 'critical')).toEqual({ ok: true });
  });

  it('returns ok when failOn is whitespace only', () => {
    expect(evaluateFailOn('  ', 'critical')).toEqual({ ok: true });
  });

  it('returns ok when found severity is below threshold', () => {
    expect(evaluateFailOn('critical', 'warning')).toEqual({ ok: true });
    expect(evaluateFailOn('critical', 'info')).toEqual({ ok: true });
    expect(evaluateFailOn('critical', 'ok')).toEqual({ ok: true });
    expect(evaluateFailOn('warning', 'info')).toEqual({ ok: true });
    expect(evaluateFailOn('warning', 'ok')).toEqual({ ok: true });
    expect(evaluateFailOn('info', 'ok')).toEqual({ ok: true });
  });

  it('returns threshold-met when found equals threshold', () => {
    expect(evaluateFailOn('critical', 'critical')).toMatchObject({
      ok: false, reason: 'threshold-met', found: 'critical', threshold: 'critical',
    });
    expect(evaluateFailOn('warning', 'warning')).toMatchObject({
      ok: false, reason: 'threshold-met', found: 'warning', threshold: 'warning',
    });
    expect(evaluateFailOn('info', 'info')).toMatchObject({
      ok: false, reason: 'threshold-met', found: 'info', threshold: 'info',
    });
    expect(evaluateFailOn('ok', 'ok')).toMatchObject({
      ok: false, reason: 'threshold-met', found: 'ok', threshold: 'ok',
    });
  });

  it('returns threshold-met when found exceeds threshold', () => {
    expect(evaluateFailOn('warning', 'critical')).toMatchObject({
      ok: false, reason: 'threshold-met', found: 'critical', threshold: 'warning',
    });
    expect(evaluateFailOn('info', 'critical')).toMatchObject({
      ok: false, reason: 'threshold-met', found: 'critical', threshold: 'info',
    });
    expect(evaluateFailOn('ok', 'warning')).toMatchObject({
      ok: false, reason: 'threshold-met', found: 'warning', threshold: 'ok',
    });
  });

  it('returns invalid-value for unrecognised failOn', () => {
    expect(evaluateFailOn('bad-value', 'critical')).toMatchObject({
      ok: false, reason: 'invalid-value', value: 'bad-value',
    });
    expect(evaluateFailOn('UNKNOWN', 'ok')).toMatchObject({
      ok: false, reason: 'invalid-value', value: 'UNKNOWN',
    });
    expect(evaluateFailOn('none', 'ok')).toMatchObject({
      ok: false, reason: 'invalid-value', value: 'none',
    });
  });

  it('is case-insensitive for known threshold values', () => {
    expect(evaluateFailOn('WARNING', 'critical')).toMatchObject({
      ok: false, reason: 'threshold-met', threshold: 'warning',
    });
    expect(evaluateFailOn('CRITICAL', 'warning')).toEqual({ ok: true });
    expect(evaluateFailOn('Info', 'info')).toMatchObject({
      ok: false, reason: 'threshold-met', threshold: 'info',
    });
  });

  it('trims leading and trailing whitespace from failOn', () => {
    expect(evaluateFailOn('  warning  ', 'critical')).toMatchObject({
      ok: false, reason: 'threshold-met', threshold: 'warning',
    });
    expect(evaluateFailOn('\tcritical\t', 'ok')).toEqual({ ok: true });
  });
});

describe('VALID_FAIL_ON_SEVERITIES', () => {
  it('includes all four severity levels', () => {
    expect(VALID_FAIL_ON_SEVERITIES).toContain('critical');
    expect(VALID_FAIL_ON_SEVERITIES).toContain('warning');
    expect(VALID_FAIL_ON_SEVERITIES).toContain('info');
    expect(VALID_FAIL_ON_SEVERITIES).toContain('ok');
  });

  it('has exactly four entries', () => {
    expect(VALID_FAIL_ON_SEVERITIES).toHaveLength(4);
  });

  it('matches the order critical > warning > info > ok', () => {
    expect(Array.from(VALID_FAIL_ON_SEVERITIES)).toEqual(['critical', 'warning', 'info', 'ok']);
  });
});

// ── setOutput ──────────────────────────────────────────────────────────────

describe('setOutput', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'heimdall-runner-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('is a no-op when outputPath is empty string', () => {
    expect(() => setOutput('foo', 'bar', '')).not.toThrow();
  });

  it('writes the multiline-safe <<delimiter format', async () => {
    const outputFile = join(tmpDir, 'github_output');
    setOutput('severity', 'critical', outputFile);

    const content = await readFile(outputFile, 'utf8');
    expect(content).toMatch(
      /^severity<<_heimdall_eof_severity_\d+\ncritical\n_heimdall_eof_severity_\d+\n$/,
    );
  });

  it('preserves multiline values verbatim', async () => {
    const outputFile = join(tmpDir, 'github_output');
    setOutput('steps', 'step 1\nstep 2\nstep 3', outputFile);

    const content = await readFile(outputFile, 'utf8');
    expect(content).toContain('step 1\nstep 2\nstep 3');
  });

  it('appends multiple outputs sequentially in the same file', async () => {
    const outputFile = join(tmpDir, 'github_output');
    setOutput('severity', 'warning', outputFile);
    setOutput('summary', 'pod crash-loop detected', outputFile);

    const content = await readFile(outputFile, 'utf8');
    expect(content).toContain('severity<<');
    expect(content).toContain('warning');
    expect(content).toContain('summary<<');
    expect(content).toContain('pod crash-loop detected');
  });

  it('writes an empty string value correctly', async () => {
    const outputFile = join(tmpDir, 'github_output');
    setOutput('answer', '', outputFile);

    const content = await readFile(outputFile, 'utf8');
    expect(content).toMatch(
      /^answer<<_heimdall_eof_answer_\d+\n\n_heimdall_eof_answer_\d+\n$/,
    );
  });

  it('uses a unique delimiter per call to handle multiline values safely', async () => {
    const outputFile = join(tmpDir, 'github_output');
    setOutput('key', 'line1\nline2', outputFile);

    const content = await readFile(outputFile, 'utf8');
    const match = content.match(/^key<<(.+)\n([\s\S]*?)\n\1\n$/);
    expect(match).not.toBeNull();
    expect(match![2]).toBe('line1\nline2');
  });
});

// ── appendSummary ──────────────────────────────────────────────────────────

describe('appendSummary', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'heimdall-runner-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('is a no-op when summaryPath is empty string', () => {
    expect(() => appendSummary('## heading', '')).not.toThrow();
  });

  it('appends markdown followed by a single newline', async () => {
    const summaryFile = join(tmpDir, 'step_summary.md');
    appendSummary('## Heimdall Report', summaryFile);

    const content = await readFile(summaryFile, 'utf8');
    expect(content).toBe('## Heimdall Report\n');
  });

  it('appends multiple sections to the same file in order', async () => {
    const summaryFile = join(tmpDir, 'step_summary.md');
    appendSummary('## Section 1', summaryFile);
    appendSummary('## Section 2', summaryFile);

    const content = await readFile(summaryFile, 'utf8');
    expect(content).toBe('## Section 1\n## Section 2\n');
  });

  it('handles multiline markdown blocks', async () => {
    const summaryFile = join(tmpDir, 'step_summary.md');
    const block = '## Title\n\nParagraph text.\n\n- bullet';
    appendSummary(block, summaryFile);

    const content = await readFile(summaryFile, 'utf8');
    expect(content).toBe(block + '\n');
  });

  it('handles empty string markdown', async () => {
    const summaryFile = join(tmpDir, 'step_summary.md');
    appendSummary('', summaryFile);

    const content = await readFile(summaryFile, 'utf8');
    expect(content).toBe('\n');
  });
});

// ── capture ────────────────────────────────────────────────────────────────

describe('capture', () => {
  it('captures stdout from a simple command and returns exit code 0', async () => {
    // Use the Node.js binary itself to print a known string — avoids spawning
    // any cluster tool and works cross-platform.
    const { stdout, code } = await capture(
      process.execPath,
      ['-e', 'process.stdout.write("hello-capture")'],
    );
    expect(stdout).toBe('hello-capture');
    expect(code).toBe(0);
  });

  it('returns a non-zero code when the child exits with a failure code', async () => {
    const { code } = await capture(process.execPath, ['-e', 'process.exit(42)']);
    expect(code).toBe(42);
  });

  it('accumulates multiple data chunks into a single stdout string', async () => {
    // Write two pieces of output; Node buffers them but the handler concatenates.
    const { stdout, code } = await capture(
      process.execPath,
      ['-e', 'process.stdout.write("part1"); process.stdout.write("part2");'],
    );
    expect(stdout).toBe('part1part2');
    expect(code).toBe(0);
  });

  it('returns code 1 and an error message when the binary cannot be found', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { code } = await capture('/nonexistent-binary-xyz', []);
    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('spawn error'));
  });
});

// ── readActionConfig ───────────────────────────────────────────────────────

describe('readActionConfig', () => {
  it('returns defaults when no env vars are set', () => {
    const cfg = readActionConfig();
    expect(cfg.mode).toBe('prompt');
    expect(cfg.prompt).toBe('');
    expect(cfg.namespace).toBe('');
    expect(cfg.allNamespaces).toBe(false);
    expect(cfg.failOn).toBe('');
    expect(cfg.postSummary).toBe(true);
    expect(cfg.githubOutput).toBe('');
    expect(cfg.githubStepSummary).toBe('');
  });

  it('reads mode, prompt, namespace from env', () => {
    process.env['_HEIMDALL_ACTION_MODE'] = 'triage';
    process.env['_HEIMDALL_ACTION_PROMPT'] = 'Check pod health';
    process.env['_HEIMDALL_ACTION_NAMESPACE'] = 'production';
    const cfg = readActionConfig();
    expect(cfg.mode).toBe('triage');
    expect(cfg.prompt).toBe('Check pod health');
    expect(cfg.namespace).toBe('production');
  });

  it('sets allNamespaces when _HEIMDALL_ACTION_ALL_NAMESPACES=true', () => {
    process.env['_HEIMDALL_ACTION_ALL_NAMESPACES'] = 'true';
    expect(readActionConfig().allNamespaces).toBe(true);
  });

  it('leaves allNamespaces false for other values', () => {
    process.env['_HEIMDALL_ACTION_ALL_NAMESPACES'] = 'false';
    expect(readActionConfig().allNamespaces).toBe(false);
    process.env['_HEIMDALL_ACTION_ALL_NAMESPACES'] = '1';
    expect(readActionConfig().allNamespaces).toBe(false);
  });

  it('trims whitespace from failOn', () => {
    process.env['_HEIMDALL_ACTION_FAIL_ON'] = '  warning  ';
    expect(readActionConfig().failOn).toBe('warning');
  });

  it('sets postSummary to false only when env is "false"', () => {
    process.env['_HEIMDALL_ACTION_POST_SUMMARY'] = 'false';
    expect(readActionConfig().postSummary).toBe(false);
    process.env['_HEIMDALL_ACTION_POST_SUMMARY'] = '0';
    expect(readActionConfig().postSummary).toBe(true);
  });

  it('reads GITHUB_OUTPUT and GITHUB_STEP_SUMMARY', () => {
    process.env['GITHUB_OUTPUT'] = '/tmp/output';
    process.env['GITHUB_STEP_SUMMARY'] = '/tmp/summary';
    const cfg = readActionConfig();
    expect(cfg.githubOutput).toBe('/tmp/output');
    expect(cfg.githubStepSummary).toBe('/tmp/summary');
  });
});

// ── checkFailOnSeverity ────────────────────────────────────────────────────

describe('checkFailOnSeverity', () => {
  it('does nothing when failOn is empty', () => {
    const exitSpy = stubExit();
    expect(() => checkFailOnSeverity('', 'critical')).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('does nothing when found severity is below threshold', () => {
    const exitSpy = stubExit();
    checkFailOnSeverity('critical', 'warning');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('calls process.exit(1) when threshold-met', () => {
    stubExit();
    expect(() => checkFailOnSeverity('warning', 'critical')).toThrow('process.exit(1)');
  });

  it('calls process.exit(1) for invalid-value failOn', () => {
    stubExit();
    expect(() => checkFailOnSeverity('bad-threshold', 'critical')).toThrow('process.exit(1)');
  });

  it('exits when found severity equals the threshold', () => {
    stubExit();
    expect(() => checkFailOnSeverity('warning', 'warning')).toThrow('process.exit(1)');
  });
});

// ── runPromptMode ──────────────────────────────────────────────────────────

describe('runPromptMode', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'heimdall-runner-test-'));
    stubExit();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('exits 1 when prompt is empty', async () => {
    const mockCapture = vi.fn();
    const cfg = makeConfig({ prompt: '' });
    await expect(runPromptMode(cfg, mockCapture)).rejects.toThrow('process.exit(1)');
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('exits 1 when prompt is whitespace-only', async () => {
    const mockCapture = vi.fn();
    const cfg = makeConfig({ prompt: '   \t\n  ' });
    await expect(runPromptMode(cfg, mockCapture)).rejects.toThrow('process.exit(1)');
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('exits with the capture exit code when heimdall exits non-zero', async () => {
    const mockCapture = vi.fn().mockResolvedValue({ stdout: '', code: 2 });
    const cfg = makeConfig();
    await expect(runPromptMode(cfg, mockCapture)).rejects.toThrow('process.exit(2)');
  });

  it('exits 1 when stdout is not valid JSON', async () => {
    const mockCapture = vi.fn().mockResolvedValue({ stdout: 'not-json', code: 0 });
    const cfg = makeConfig();
    await expect(runPromptMode(cfg, mockCapture)).rejects.toThrow('process.exit(1)');
  });

  it('calls setOutput for each finding field on success', async () => {
    const outputFile = join(tmpDir, 'output');
    const mockCapture = vi.fn().mockResolvedValue({
      stdout: JSON.stringify(FINDING),
      code: 0,
    });
    const cfg = makeConfig({ githubOutput: outputFile });
    await runPromptMode(cfg, mockCapture);

    const content = await readFile(outputFile, 'utf8');
    expect(content).toContain('severity<<');
    expect(content).toContain('critical');
    expect(content).toContain('summary<<');
    expect(content).toContain('answer<<');
    expect(content).toContain('summary-markdown<<');
  });

  it('does NOT write to summary file when postSummary is false', async () => {
    const summaryFile = join(tmpDir, 'summary');
    const mockCapture = vi.fn().mockResolvedValue({
      stdout: JSON.stringify(FINDING),
      code: 0,
    });
    const cfg = makeConfig({ postSummary: false, githubStepSummary: summaryFile });
    await runPromptMode(cfg, mockCapture);

    // summaryFile should not exist since postSummary is false
    await expect(readFile(summaryFile, 'utf8')).rejects.toThrow();
  });

  it('writes to summary file when postSummary is true', async () => {
    const outputFile = join(tmpDir, 'output');
    const summaryFile = join(tmpDir, 'summary');
    const mockCapture = vi.fn().mockResolvedValue({
      stdout: JSON.stringify(FINDING),
      code: 0,
    });
    const cfg = makeConfig({ postSummary: true, githubOutput: outputFile, githubStepSummary: summaryFile });
    await runPromptMode(cfg, mockCapture);

    const content = await readFile(summaryFile, 'utf8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('exits 1 when fail-on threshold is met', async () => {
    const mockCapture = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ ...FINDING, severity: 'critical' }),
      code: 0,
    });
    const cfg = makeConfig({ failOn: 'critical' });
    await expect(runPromptMode(cfg, mockCapture)).rejects.toThrow('process.exit(1)');
  });

  it('does not exit when severity is below fail-on threshold', async () => {
    const outputFile = join(tmpDir, 'output');
    const mockCapture = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ ...FINDING, severity: 'info' }),
      code: 0,
    });
    const cfg = makeConfig({ failOn: 'critical', githubOutput: outputFile });
    await expect(runPromptMode(cfg, mockCapture)).resolves.toBeUndefined();
  });

  it('passes the correct args to captureImpl', async () => {
    const outputFile = join(tmpDir, 'output');
    const mockCapture = vi.fn().mockResolvedValue({
      stdout: JSON.stringify(FINDING),
      code: 0,
    });
    const cfg = makeConfig({ prompt: 'Check my pods', githubOutput: outputFile });
    await runPromptMode(cfg, mockCapture);

    expect(mockCapture).toHaveBeenCalledOnce();
    const [, args] = mockCapture.mock.calls[0] as [string, string[]];
    expect(args).toContain('-p');
    expect(args).toContain('Check my pods');
    expect(args).toContain('--json');
    expect(args).toContain('--no-learn');
  });
});

// ── runTriageMode ──────────────────────────────────────────────────────────

describe('runTriageMode', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'heimdall-runner-test-'));
    stubExit();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('exits with capture exit code when triage exits non-zero', async () => {
    const mockCapture = vi.fn().mockResolvedValue({ stdout: '', code: 3 });
    const cfg = makeConfig({ mode: 'triage' });
    await expect(runTriageMode(cfg, mockCapture)).rejects.toThrow('process.exit(3)');
  });

  it('passes no namespace args when both namespace and allNamespaces are unset', async () => {
    const outputFile = join(tmpDir, 'output');
    const mockCapture = vi.fn().mockResolvedValue({ stdout: 'All healthy', code: 0 });
    const cfg = makeConfig({ mode: 'triage', githubOutput: outputFile });
    await runTriageMode(cfg, mockCapture);

    const [, args] = mockCapture.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['triage']);
  });

  it('passes -n <namespace> when namespace is set', async () => {
    const outputFile = join(tmpDir, 'output');
    const mockCapture = vi.fn().mockResolvedValue({ stdout: 'All healthy', code: 0 });
    const cfg = makeConfig({ mode: 'triage', namespace: 'production', githubOutput: outputFile });
    await runTriageMode(cfg, mockCapture);

    const [, args] = mockCapture.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['triage', '-n', 'production']);
  });

  it('passes -A when allNamespaces is true', async () => {
    const outputFile = join(tmpDir, 'output');
    const mockCapture = vi.fn().mockResolvedValue({ stdout: 'All healthy', code: 0 });
    const cfg = makeConfig({ mode: 'triage', allNamespaces: true, githubOutput: outputFile });
    await runTriageMode(cfg, mockCapture);

    const [, args] = mockCapture.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['triage', '-A']);
  });

  it('prefers -A over -n when both are set', async () => {
    const outputFile = join(tmpDir, 'output');
    const mockCapture = vi.fn().mockResolvedValue({ stdout: 'All healthy', code: 0 });
    const cfg = makeConfig({ mode: 'triage', allNamespaces: true, namespace: 'production', githubOutput: outputFile });
    await runTriageMode(cfg, mockCapture);

    const [, args] = mockCapture.mock.calls[0] as [string, string[]];
    expect(args).toContain('-A');
    expect(args).not.toContain('-n');
  });

  it('writes severity and other outputs on success', async () => {
    const outputFile = join(tmpDir, 'output');
    const mockCapture = vi.fn().mockResolvedValue({ stdout: 'Cluster is healthy.', code: 0 });
    const cfg = makeConfig({ mode: 'triage', githubOutput: outputFile });
    await runTriageMode(cfg, mockCapture);

    const content = await readFile(outputFile, 'utf8');
    expect(content).toContain('severity<<');
    expect(content).toContain('summary<<');
    expect(content).toContain('answer<<');
    expect(content).toContain('suggested-commands<<');
    expect(content).toContain('remediation-steps<<');
    expect(content).toContain('summary-markdown<<');
  });

  it('writes step summary when postSummary is true', async () => {
    const outputFile = join(tmpDir, 'output');
    const summaryFile = join(tmpDir, 'summary');
    const mockCapture = vi.fn().mockResolvedValue({ stdout: 'All healthy', code: 0 });
    const cfg = makeConfig({ mode: 'triage', postSummary: true, githubOutput: outputFile, githubStepSummary: summaryFile });
    await runTriageMode(cfg, mockCapture);

    const content = await readFile(summaryFile, 'utf8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('does not write step summary when postSummary is false', async () => {
    const summaryFile = join(tmpDir, 'summary');
    const mockCapture = vi.fn().mockResolvedValue({ stdout: 'All healthy', code: 0 });
    const cfg = makeConfig({ mode: 'triage', postSummary: false, githubStepSummary: summaryFile });
    await runTriageMode(cfg, mockCapture);

    await expect(readFile(summaryFile, 'utf8')).rejects.toThrow();
  });

  it('exits 1 when fail-on threshold is met', async () => {
    const outputFile = join(tmpDir, 'output');
    // detectTriageSeverity matches "critical" at line start (per its regex)
    const mockCapture = vi.fn().mockResolvedValue({
      stdout: 'Triage complete.\ncritical\nPod crash-looping.',
      code: 0,
    });
    const cfg = makeConfig({ mode: 'triage', failOn: 'critical', githubOutput: outputFile });
    await expect(runTriageMode(cfg, mockCapture)).rejects.toThrow('process.exit(1)');
  });
});

// ── runScheduleOnceMode ────────────────────────────────────────────────────

describe('runScheduleOnceMode', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'heimdall-runner-test-'));
    stubExit();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('exits with capture exit code when schedule exits non-zero', async () => {
    const mockCapture = vi.fn().mockResolvedValue({ stdout: '', code: 5 });
    const cfg = makeConfig({ mode: 'schedule-once' });
    await expect(runScheduleOnceMode(cfg, mockCapture)).rejects.toThrow('process.exit(5)');
  });

  it('passes schedule --once args to captureImpl', async () => {
    const outputFile = join(tmpDir, 'output');
    const mockCapture = vi.fn().mockResolvedValue({ stdout: '', code: 0 });
    const cfg = makeConfig({ mode: 'schedule-once', githubOutput: outputFile });
    await runScheduleOnceMode(cfg, mockCapture);

    const [, args] = mockCapture.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['schedule', '--once']);
  });

  it('writes ok severity and standard outputs on success', async () => {
    const outputFile = join(tmpDir, 'output');
    const mockCapture = vi.fn().mockResolvedValue({ stdout: '', code: 0 });
    const cfg = makeConfig({ mode: 'schedule-once', githubOutput: outputFile });
    await runScheduleOnceMode(cfg, mockCapture);

    const content = await readFile(outputFile, 'utf8');
    expect(content).toContain('severity<<');
    expect(content).toContain('ok');
    expect(content).toContain('summary<<');
    expect(content).toContain('Scheduled triage completed.');
    expect(content).toContain('answer<<');
    expect(content).toContain('suggested-commands<<');
    expect(content).toContain('remediation-steps<<');
    expect(content).toContain('summary-markdown<<');
  });

  it('writes non-empty summary-markdown output on success', async () => {
    const outputFile = join(tmpDir, 'output');
    const mockCapture = vi.fn().mockResolvedValue({ stdout: '', code: 0 });
    const cfg = makeConfig({ mode: 'schedule-once', githubOutput: outputFile });
    await runScheduleOnceMode(cfg, mockCapture);

    const content = await readFile(outputFile, 'utf8');
    expect(content).toMatch(/summary-markdown<<[^\n]+\n## Heimdall Schedule/);
  });

  it('appends to step summary when postSummary is true', async () => {
    const summaryFile = join(tmpDir, 'summary');
    const mockCapture = vi.fn().mockResolvedValue({ stdout: '', code: 0 });
    const cfg = makeConfig({ mode: 'schedule-once', postSummary: true, githubStepSummary: summaryFile });
    await runScheduleOnceMode(cfg, mockCapture);

    const content = await readFile(summaryFile, 'utf8');
    expect(content).toContain('## Heimdall Schedule');
    expect(content).toContain('Scheduled triage completed.');
  });

  it('does not write step summary when postSummary is false', async () => {
    const summaryFile = join(tmpDir, 'summary');
    const mockCapture = vi.fn().mockResolvedValue({ stdout: '', code: 0 });
    const cfg = makeConfig({ mode: 'schedule-once', postSummary: false, githubStepSummary: summaryFile });
    await runScheduleOnceMode(cfg, mockCapture);

    await expect(readFile(summaryFile, 'utf8')).rejects.toThrow('ENOENT');
  });

  it('exits 1 when fail-on threshold is met', async () => {
    const mockCapture = vi.fn().mockResolvedValue({ stdout: '', code: 0 });
    const cfg = makeConfig({ mode: 'schedule-once', failOn: 'ok' });
    await expect(runScheduleOnceMode(cfg, mockCapture)).rejects.toThrow('process.exit(1)');
  });

  it('does not exit when fail-on is empty', async () => {
    const mockCapture = vi.fn().mockResolvedValue({ stdout: '', code: 0 });
    const cfg = makeConfig({ mode: 'schedule-once', failOn: '' });
    await expect(runScheduleOnceMode(cfg, mockCapture)).resolves.toBeUndefined();
  });
});

// ── main (dispatch) ────────────────────────────────────────────────────────

describe('main — dispatch', () => {
  beforeEach(() => {
    stubExit();
  });

  afterEach(() => {
    for (const key of [
      '_HEIMDALL_ACTION_MODE',
      '_HEIMDALL_ACTION_PROMPT',
      '_HEIMDALL_ACTION_NAMESPACE',
      '_HEIMDALL_ACTION_ALL_NAMESPACES',
      '_HEIMDALL_ACTION_FAIL_ON',
      '_HEIMDALL_ACTION_POST_SUMMARY',
      'GITHUB_OUTPUT',
      'GITHUB_STEP_SUMMARY',
    ]) {
      delete process.env[key];
    }
  });

  it('dispatches to runTriageMode when mode is "triage"', async () => {
    process.env['_HEIMDALL_ACTION_MODE'] = 'triage';
    const mockCapture = vi.fn().mockResolvedValue({ stdout: 'Cluster is healthy.', code: 0 });
    await main(mockCapture);
    expect(mockCapture).toHaveBeenCalledOnce();
    const [, args] = mockCapture.mock.calls[0] as [string, string[]];
    expect(args).toContain('triage');
  });

  it('dispatches to runScheduleOnceMode when mode is "schedule-once"', async () => {
    process.env['_HEIMDALL_ACTION_MODE'] = 'schedule-once';
    const mockCapture = vi.fn().mockResolvedValue({ stdout: '', code: 0 });
    await main(mockCapture);
    expect(mockCapture).toHaveBeenCalledOnce();
    const [, args] = mockCapture.mock.calls[0] as [string, string[]];
    expect(args).toContain('schedule');
    expect(args).toContain('--once');
  });

  it('dispatches to runPromptMode when mode is "prompt"', async () => {
    process.env['_HEIMDALL_ACTION_MODE'] = 'prompt';
    process.env['_HEIMDALL_ACTION_PROMPT'] = 'Why is my pod crashing?';
    const mockCapture = vi.fn().mockResolvedValue({ stdout: JSON.stringify(FINDING), code: 0 });
    await main(mockCapture);
    expect(mockCapture).toHaveBeenCalledOnce();
    const [, args] = mockCapture.mock.calls[0] as [string, string[]];
    expect(args).toContain('-p');
    expect(args).toContain('Why is my pod crashing?');
  });

  it('defaults to runPromptMode for an unrecognised mode', async () => {
    process.env['_HEIMDALL_ACTION_MODE'] = 'unknown-mode';
    process.env['_HEIMDALL_ACTION_PROMPT'] = 'test prompt';
    const mockCapture = vi.fn().mockResolvedValue({ stdout: JSON.stringify(FINDING), code: 0 });
    await main(mockCapture);
    expect(mockCapture).toHaveBeenCalledOnce();
    const [, args] = mockCapture.mock.calls[0] as [string, string[]];
    expect(args).toContain('-p');
  });
});
