/**
 * Tests for cli-exec.ts — the shared execFile -> redact -> audit -> truncate
 * pipeline used by aws.ts, cdk.ts, helm.ts, and trivy.ts.
 *
 * Real binaries are NOT invoked. Exec paths are exercised via a vi.mock on
 * node:child_process, matching the pattern used by helm.test.ts / trivy.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import {
  execAndReport,
  formatExecSuccessOutput,
  formatExecErrorMessage,
  DEFAULT_NO_OUTPUT_MESSAGE,
} from '../cli-exec.ts';
import { stubExec, resetExec } from './execfile-helpers.ts';
import { compileRules } from '../regex-redact.ts';
import { makeTruncate } from '../output-truncation.ts';

beforeEach(() => {
  resetExec();
});

const baseParams = {
  bin: 'testbin',
  argv: ['list'],
  cmd: 'testbin list',
  startTs: '2026-01-01T00:00:00.000Z',
  startMs: 0,
  execOptions: { timeout: 1000, maxBuffer: 1024 },
  noOutputMessage: DEFAULT_NO_OUTPUT_MESSAGE,
  truncate: (text: string) => text,
};

describe('formatExecSuccessOutput', () => {
  it('returns trimmed stdout when present', () => {
    expect(formatExecSuccessOutput('  out  ', 'err', 'none')).toBe('out');
  });

  it('falls back to trimmed stderr when stdout is blank', () => {
    expect(formatExecSuccessOutput('   ', '  err  ', 'none')).toBe('err');
  });

  it('falls back to the no-output message when both are blank', () => {
    expect(formatExecSuccessOutput('', '  ', 'none')).toBe('none');
  });
});

describe('formatExecErrorMessage', () => {
  it('prefixes detail with "<bin> exited with an error" when not passthrough', () => {
    expect(formatExecErrorMessage('kubectl', 'boom', false, 'fallback')).toBe('kubectl exited with an error:\nboom');
  });

  it('returns detail as-is when passthrough and detail is non-empty', () => {
    expect(formatExecErrorMessage('trivy', 'Total: 5 (CRITICAL: 5)', true, 'fallback')).toBe('Total: 5 (CRITICAL: 5)');
  });

  it('falls back to the prefixed fallbackDetail when passthrough and detail is empty', () => {
    expect(formatExecErrorMessage('trivy', '', true, 'fallback')).toBe('trivy exited with an error:\nfallback');
  });
});

describe('execAndReport — success paths', () => {
  it('returns trimmed stdout', async () => {
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: '  hello  ', stderr: '' }));
    const result = await execAndReport(baseParams);
    expect(result).toBe('hello');
  });

  it('falls back to trimmed stderr when stdout is blank', async () => {
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: '   ', stderr: '  warn  ' }));
    const result = await execAndReport(baseParams);
    expect(result).toBe('warn');
  });

  it('returns the no-output message when stdout and stderr are both blank', async () => {
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: '' }));
    const result = await execAndReport(baseParams);
    expect(result).toBe(DEFAULT_NO_OUTPUT_MESSAGE);
  });

  it('applies regex redaction rules to successful output', async () => {
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: 'key=AKIAIOSFODNN7EXAMPLE', stderr: '' }));
    const rules = compileRules([{ name: 'aws-key', pattern: 'AKIA[0-9A-Z]{16}' }]);
    const result = await execAndReport({ ...baseParams, regexRedactionRules: rules });
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result).toContain('[REDACTED:aws-key]');
  });

  it('truncates output via the supplied truncate function', async () => {
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: 'A'.repeat(200), stderr: '' }));
    const truncate = makeTruncate(50, 'narrow the query');
    const result = await execAndReport({ ...baseParams, truncate });
    expect(result.length).toBeLessThan(200);
    expect(result).toContain('[output truncated');
  });
});

describe('execAndReport — error paths (non-passthrough)', () => {
  it('prefixes stderr detail with "<bin> exited with an error"', async () => {
    const err = Object.assign(new Error('exit 1'), { stderr: 'access denied', stdout: '' });
    stubExec((_cmd, _args, _opts, cb) => cb(err, { stdout: '', stderr: '' }));
    const result = await execAndReport(baseParams);
    expect(result).toBe('testbin exited with an error:\naccess denied');
  });

  it('falls back to err.stdout when err.stderr is empty', async () => {
    const err = Object.assign(new Error('exit 1'), { stderr: '', stdout: 'not found' });
    stubExec((_cmd, _args, _opts, cb) => cb(err, { stdout: '', stderr: '' }));
    const result = await execAndReport(baseParams);
    expect(result).toBe('testbin exited with an error:\nnot found');
  });

  it('falls back to err.message when stderr and stdout are empty', async () => {
    const err = Object.assign(new Error('binary not found'), { stderr: '', stdout: '' });
    stubExec((_cmd, _args, _opts, cb) => cb(err, { stdout: '', stderr: '' }));
    const result = await execAndReport(baseParams);
    expect(result).toBe('testbin exited with an error:\nbinary not found');
  });

  it('applies regex redaction rules to error detail', async () => {
    const err = Object.assign(new Error('fail'), { stderr: 'token=AKIAIOSFODNN7EXAMPLE', stdout: '' });
    stubExec((_cmd, _args, _opts, cb) => cb(err, { stdout: '', stderr: '' }));
    const rules = compileRules([{ name: 'aws-key', pattern: 'AKIA[0-9A-Z]{16}' }]);
    const result = await execAndReport({ ...baseParams, regexRedactionRules: rules });
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result).toContain('[REDACTED:aws-key]');
  });

  it('respects stdoutFirst when preferring error detail source', async () => {
    const err = Object.assign(new Error('exit 1'), { stderr: 'stderr detail', stdout: 'stdout detail' });
    stubExec((_cmd, _args, _opts, cb) => cb(err, { stdout: '', stderr: '' }));
    const result = await execAndReport({ ...baseParams, stdoutFirst: true });
    expect(result).toBe('testbin exited with an error:\nstdout detail');
  });
});

describe('execAndReport — error paths (passthroughOnError)', () => {
  it('returns detail as-is, without the error prefix, when detail is non-empty', async () => {
    const err = Object.assign(new Error('exit 1'), { stdout: 'Total: 5 (CRITICAL: 5)', stderr: '' });
    stubExec((_cmd, _args, _opts, cb) => cb(err, { stdout: '', stderr: '' }));
    const result = await execAndReport({ ...baseParams, stdoutFirst: true, passthroughOnError: true });
    expect(result).toBe('Total: 5 (CRITICAL: 5)');
  });

  it('falls back to the generic prefixed message when detail is empty after redaction', async () => {
    // toString() returns '' so getExecErrorDetail's String(error) fallback is also empty.
    const err = Object.assign(Object.create({ toString: () => '' }), {
      stderr: '', stdout: '', message: '',
    });
    stubExec((_cmd, _args, _opts, cb) => cb(err as unknown as Error, { stdout: '', stderr: '' }));
    const result = await execAndReport({ ...baseParams, passthroughOnError: true });
    expect(result).toBe('testbin exited with an error:\n');
  });
});
