/**
 * Tests for cdk.ts — tokenization, policy decisions, and exec paths.
 *
 * Real `cdk` CLI is NOT invoked. We assert:
 *  1. tokenizeCdkArgs handles quoting, escaping, and strips the leading "cdk" token.
 *  2. runCdk returns before exec for blocked commands and empty inputs.
 *  3. runCdk correctly handles exec success, empty output, and error paths (mocked execFile).
 */

// node:child_process must be mocked before cdk.ts is imported so that
// `execFileAsync = promisify(execFile)` captures the mock at module load time.
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Allow per-test override of validateCdkCommand to reach the !validation path.
vi.mock('../cdk-safety.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../cdk-safety.ts')>();
  return { ...original, validateCdkCommand: vi.fn(original.validateCdkCommand) };
});

import { tokenizeCdkArgs, runCdk, NO_OUTPUT_MESSAGE } from '../cdk.ts';
import { validateCdkCommand } from '../cdk-safety.ts';
import { BLOCKED_RE } from './test-helpers.ts';
import { stubExec, resetExec } from './execfile-helpers.ts';
import { compileRules } from '../regex-redact.ts';

describe('tokenizeCdkArgs', () => {
  it('strips a leading cdk token (lowercase)', () => {
    expect(tokenizeCdkArgs('cdk ls')).toEqual(['ls']);
  });

  it('strips a leading CDK token (uppercase)', () => {
    expect(tokenizeCdkArgs('CDK diff MyStack')).toEqual(['diff', 'MyStack']);
  });

  it('keeps tokens when no leading cdk is present', () => {
    expect(tokenizeCdkArgs('ls')).toEqual(['ls']);
  });

  it('handles single-quoted arguments', () => {
    expect(tokenizeCdkArgs("diff --app 'node app.js' MyStack")).toEqual([
      'diff',
      '--app',
      'node app.js',
      'MyStack',
    ]);
  });

  it('handles double-quoted arguments', () => {
    expect(tokenizeCdkArgs('diff --app "node app.js" MyStack')).toEqual([
      'diff',
      '--app',
      'node app.js',
      'MyStack',
    ]);
  });

  it('handles escaped characters inside double quotes', () => {
    expect(tokenizeCdkArgs('synth --app "node \\\"app.js\\\""')).toEqual([
      'synth',
      '--app',
      'node "app.js"',
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(tokenizeCdkArgs('')).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(tokenizeCdkArgs('   ')).toEqual([]);
  });

  it('handles multiple spaces between tokens', () => {
    expect(tokenizeCdkArgs('cdk   diff   MyStack')).toEqual(['diff', 'MyStack']);
  });

  it('handles --profile flag', () => {
    expect(tokenizeCdkArgs('cdk --profile prod diff MyStack')).toEqual([
      '--profile',
      'prod',
      'diff',
      'MyStack',
    ]);
  });
});

describe('runCdk — input validation (no exec)', () => {
  it('returns error for empty args', async () => {
    const result = await runCdk('');
    expect(result).toMatch(/no CDK CLI arguments provided/i);
  });

  it('returns error for whitespace-only args', async () => {
    const result = await runCdk('   ');
    expect(result).toMatch(/no CDK CLI arguments provided/i);
  });

  it('blocks deploy before exec (BLOCKED_PREFIX)', async () => {
    const result = await runCdk('deploy');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks cdk deploy MyStack before exec', async () => {
    const result = await runCdk('cdk deploy MyStack');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks destroy before exec', async () => {
    const result = await runCdk('destroy MyStack');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks bootstrap before exec', async () => {
    const result = await runCdk('bootstrap');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks watch before exec', async () => {
    const result = await runCdk('watch MyStack');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks gc before exec', async () => {
    const result = await runCdk('gc');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks rollback before exec', async () => {
    const result = await runCdk('rollback MyStack');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks unknown subcommands (default-deny)', async () => {
    const result = await runCdk('exec-this-strange-command');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks unknown subcommand derived from a non-CDK string', async () => {
    // runCdk prepends "cdk " to inputs not already starting with "cdk",
    // so "kubectl get pods" → "cdk kubectl get pods" → unknown subcommand "kubectl" → blocked.
    const result = await runCdk('kubectl get pods');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks destructive command even when preceded by global flags', async () => {
    const result = await runCdk('--profile prod deploy MyStack');
    expect(result).toMatch(BLOCKED_RE);
  });
});

// ---------------------------------------------------------------------------
// runCdk — argv.length === 0 guard (no exec)
// `cdk` with no subcommand passes validation (bare `cdk` is harmless) but
// tokenizeCdkArgs strips the leading "cdk" token leaving an empty argv.
// ---------------------------------------------------------------------------

describe('runCdk — argv.length === 0 guard (no exec)', () => {
  it('returns an error when "cdk" is passed with no subcommand', async () => {
    const result = await runCdk('cdk');
    expect(result).toMatch(/no CDK subcommand provided/i);
  });
});

// ---------------------------------------------------------------------------
// runCdk — exec success paths (mocked child_process)
// ---------------------------------------------------------------------------

describe('runCdk — exec success paths (mocked execFile)', () => {
  beforeEach(() => resetExec());
  afterEach(() => resetExec());

  it('returns trimmed stdout when the command succeeds', async () => {
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: 'stack-a\nstack-b\n', stderr: '' }));
    const result = await runCdk('ls');
    expect(result).toBe('stack-a\nstack-b');
  });

  it('falls back to stderr when stdout is empty', async () => {
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: 'Warning: no stacks found\n' }));
    const result = await runCdk('ls');
    expect(result).toBe('Warning: no stacks found');
  });

  it('returns NO_OUTPUT_MESSAGE when both stdout and stderr are empty', async () => {
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: '' }));
    const result = await runCdk('ls');
    expect(result).toBe(NO_OUTPUT_MESSAGE);
  });

  it('applies regex redaction rules to stdout output', async () => {
    const rules = compileRules([{ name: 'api-key', pattern: 'MY-SECRET' }]);
    stubExec((_cmd, _args, _opts, cb) =>
      cb(null, { stdout: 'synth output: MY-SECRET token\n', stderr: '' }),
    );
    const result = await runCdk('synth', { regexRedactionRules: rules });
    expect(result).not.toContain('MY-SECRET');
    expect(result).toContain('[REDACTED:api-key]');
  });
});

// ---------------------------------------------------------------------------
// runCdk — exec error paths (mocked child_process)
// ---------------------------------------------------------------------------

describe('runCdk — exec error paths (mocked execFile)', () => {
  beforeEach(() => resetExec());
  afterEach(() => resetExec());

  it('returns an error message with stderr detail on exec failure', async () => {
    const err = Object.assign(new Error('exit 1'), { stderr: 'CDK error: stack not found' });
    stubExec((_cmd, _args, _opts, cb) => cb(err, { stdout: '', stderr: '' }));
    const result = await runCdk('synth');
    expect(result).toMatch(/cdk exited with an error/i);
    expect(result).toContain('CDK error: stack not found');
  });

  it('falls back to err.stdout when stderr is empty on failure', async () => {
    const err = Object.assign(new Error('exit 1'), { stderr: '', stdout: 'partial stdout output' });
    stubExec((_cmd, _args, _opts, cb) => cb(err, { stdout: '', stderr: '' }));
    const result = await runCdk('synth');
    expect(result).toMatch(/cdk exited with an error/i);
    expect(result).toContain('partial stdout output');
  });

  it('falls back to err.message when stderr and stdout are empty on failure', async () => {
    const err = new Error('cdk: command not found');
    stubExec((_cmd, _args, _opts, cb) => cb(err, { stdout: '', stderr: '' }));
    const result = await runCdk('synth');
    expect(result).toMatch(/cdk exited with an error/i);
    expect(result).toContain('cdk: command not found');
  });

  it('applies regex redaction rules to error output', async () => {
    const rules = compileRules([{ name: 'secret', pattern: 'SENSITIVE' }]);
    const err = Object.assign(new Error('exit 1'), { stderr: 'Error: SENSITIVE token exposed' });
    stubExec((_cmd, _args, _opts, cb) => cb(err, { stdout: '', stderr: '' }));
    const result = await runCdk('synth', { regexRedactionRules: rules });
    expect(result).not.toContain('SENSITIVE');
    expect(result).toContain('[REDACTED:secret]');
  });

  it('forwards the cwd option to execFile', async () => {
    let capturedOpts: unknown = null;
    stubExec((_cmd, _args, opts, cb) => {
      capturedOpts = opts;
      cb(null, { stdout: 'ok', stderr: '' });
    });
    await runCdk('ls', { cwd: '/tmp/custom-cwd' });
    expect(capturedOpts).toBeDefined();
    expect((capturedOpts as Record<string, unknown>)?.cwd).toBe('/tmp/custom-cwd');
  });

  it('falls back to String(error) when err.stderr, err.stdout, and err.message are all empty', async () => {
    const err = Object.assign(new Error(), { stderr: '', stdout: '', message: '' });
    stubExec((_cmd, _args, _opts, cb) => cb(err as unknown as Error, { stdout: '', stderr: '' }));
    const result = await runCdk('synth');
    expect(result).toMatch(/cdk exited with an error|Error/i);
  });
});

describe('runCdk — validateCdkCommand returns null', () => {
  it('returns "could not parse" when validateCdkCommand returns null', async () => {
    vi.mocked(validateCdkCommand).mockReturnValueOnce(null);
    const result = await runCdk('ls');
    expect(result).toMatch(/could not parse CDK CLI command/i);
  });
});
