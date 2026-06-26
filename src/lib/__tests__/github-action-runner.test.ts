import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setOutput, appendSummary } from '../github-action-runner.ts';
import {
  evaluateFailOn,
  VALID_FAIL_ON_SEVERITIES,
} from '../github-action.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

// ── evaluateFailOn ─────────────────────────────────────────────────────────

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
    // The value must appear between two identical delimiters
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
