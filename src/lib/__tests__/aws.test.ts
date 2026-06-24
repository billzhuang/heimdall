/**
 * Tests for aws.ts — tokenization, policy decisions, and exec paths.
 *
 * Real `aws` CLI is NOT invoked. We assert:
 *  1. tokenizeAwsArgs handles quoting, escaping, and strips the leading "aws" token.
 *  2. runAwsCli returns before exec for blocked commands and empty inputs.
 *  3. runAwsCli exec paths (success, error, redaction) via mocked child_process.
 */

// node:child_process must be mocked before aws.ts is imported so that
// `execFileAsync = promisify(execFile)` captures the mock at module load time.
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, execFile: vi.fn() };
});

// aws-safety is mocked to allow per-test overrides of validateAwsCommand
// while delegating to the real implementation by default.
vi.mock('../aws-safety.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../aws-safety.ts')>();
  return { ...original, validateAwsCommand: vi.fn(original.validateAwsCommand) };
});

import { tokenizeAwsArgs, runAwsCli, detectAwsAuth, NO_OUTPUT_MESSAGE } from '../aws.ts';
import { validateAwsCommand } from '../aws-safety.ts';
import { BLOCKED_RE } from './test-helpers.ts';
import { stubExec, resetExec } from './execfile-helpers.ts';
import { compileRules } from '../regex-redact.ts';

describe('tokenizeAwsArgs', () => {
  it('strips a leading aws token (lowercase)', () => {
    expect(tokenizeAwsArgs('aws ec2 describe-instances')).toEqual(['ec2', 'describe-instances']);
  });

  it('strips a leading AWS token (uppercase)', () => {
    expect(tokenizeAwsArgs('AWS s3api list-buckets')).toEqual(['s3api', 'list-buckets']);
  });

  it('keeps tokens when no leading aws is present', () => {
    expect(tokenizeAwsArgs('ec2 describe-instances')).toEqual(['ec2', 'describe-instances']);
  });

  it('handles single-quoted arguments', () => {
    expect(tokenizeAwsArgs("aws ec2 describe-instances --filters 'Name=tag:Env,Values=prod'")).toEqual([
      'ec2',
      'describe-instances',
      '--filters',
      'Name=tag:Env,Values=prod',
    ]);
  });

  it('handles double-quoted arguments', () => {
    expect(tokenizeAwsArgs('aws sts get-caller-identity --query "Account"')).toEqual([
      'sts',
      'get-caller-identity',
      '--query',
      'Account',
    ]);
  });

  it('handles escaped characters inside double quotes', () => {
    expect(tokenizeAwsArgs('aws ec2 describe-instances --query "Reservations[0].Instances[0].\\\"InstanceId\\\""')).toEqual([
      'ec2',
      'describe-instances',
      '--query',
      'Reservations[0].Instances[0]."InstanceId"',
    ]);
  });

  it('handles backslash escapes outside quotes', () => {
    expect(tokenizeAwsArgs('aws ec2 describe-instances --output\\ text')).toEqual([
      'ec2',
      'describe-instances',
      '--output text',
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(tokenizeAwsArgs('')).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(tokenizeAwsArgs('   ')).toEqual([]);
  });

  it('handles multiple spaces between tokens', () => {
    expect(tokenizeAwsArgs('aws   ec2   describe-instances')).toEqual(['ec2', 'describe-instances']);
  });

  it('handles --region flag', () => {
    expect(tokenizeAwsArgs('aws --region us-east-1 eks describe-cluster --name my-cluster')).toEqual([
      '--region',
      'us-east-1',
      'eks',
      'describe-cluster',
      '--name',
      'my-cluster',
    ]);
  });
});

describe('runAwsCli — input validation (no exec)', () => {
  it('returns error for empty args', async () => {
    const result = await runAwsCli('');
    expect(result).toMatch(/no AWS CLI arguments provided/i);
  });

  it('returns error for whitespace-only args', async () => {
    const result = await runAwsCli('   ');
    expect(result).toMatch(/no AWS CLI arguments provided/i);
  });

  it('blocks destructive commands before exec (BLOCKED_PREFIX)', async () => {
    const result = await runAwsCli('aws ec2 terminate-instances --instance-ids i-123abc');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks ec2 delete-security-group before exec', async () => {
    const result = await runAwsCli('ec2 delete-security-group --group-id sg-123');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks rds delete-db-instance before exec', async () => {
    const result = await runAwsCli('aws rds delete-db-instance --db-instance-identifier mydb');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks iam attach-role-policy before exec', async () => {
    const result = await runAwsCli('aws iam attach-role-policy --role-name r --policy-arn a');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks unknown subcommands (default-deny)', async () => {
    const result = await runAwsCli('aws ec2 unknown-operation');
    expect(result).toMatch(BLOCKED_RE);
  });
});

// ---------------------------------------------------------------------------
// detectAwsAuth
// ---------------------------------------------------------------------------

describe('detectAwsAuth', () => {
  const saved: Record<string, string | undefined> = {};
  const VARS = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_ROLE_ARN',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  ];

  // Save originals and clear before each test
  function clearAwsVars() {
    for (const v of VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  }
  function restoreAwsVars() {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  }

  afterEach(() => restoreAwsVars());

  it('returns "static-keys" when AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set', () => {
    clearAwsVars();
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    expect(detectAwsAuth()).toBe('static-keys');
  });

  it('returns "irsa" when AWS_ROLE_ARN and AWS_WEB_IDENTITY_TOKEN_FILE are set', () => {
    clearAwsVars();
    process.env.AWS_ROLE_ARN = 'arn:aws:iam::123456789:role/my-role';
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE = '/var/run/secrets/eks.amazonaws.com/serviceaccount/token';
    expect(detectAwsAuth()).toBe('irsa');
  });

  it('returns "pod-identity" when AWS_CONTAINER_CREDENTIALS_RELATIVE_URI is set', () => {
    clearAwsVars();
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/abc123';
    expect(detectAwsAuth()).toBe('pod-identity');
  });

  it('returns "static-keys" when both static keys and IRSA vars are set (static wins)', () => {
    clearAwsVars();
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    process.env.AWS_ROLE_ARN = 'arn:aws:iam::123456789:role/my-role';
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE = '/token';
    expect(detectAwsAuth()).toBe('static-keys');
  });

  it('returns "unknown" when no AWS credential env vars are set', () => {
    clearAwsVars();
    expect(detectAwsAuth()).toBe('unknown');
  });

  it('returns "unknown" when only AWS_ROLE_ARN is set (token file missing)', () => {
    clearAwsVars();
    process.env.AWS_ROLE_ARN = 'arn:aws:iam::123456789:role/my-role';
    expect(detectAwsAuth()).toBe('unknown');
  });

  it('returns "unknown" when only AWS_WEB_IDENTITY_TOKEN_FILE is set (role ARN missing)', () => {
    clearAwsVars();
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE = '/token';
    expect(detectAwsAuth()).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// runAwsCli — exec paths (mocked child_process)
// ---------------------------------------------------------------------------

describe('runAwsCli — exec paths (mocked child_process)', () => {
  beforeEach(() => {
    resetExec();
  });

  afterEach(() => {
    resetExec();
  });

  it('returns "could not parse" when validateAwsCommand returns null', async () => {
    vi.mocked(validateAwsCommand).mockReturnValueOnce(null);
    const result = await runAwsCli('ec2 describe-instances');
    expect(result).toMatch(/could not parse AWS CLI command/i);
  });

  it('returns stdout when exec succeeds', async () => {
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: 'i-abc123\ni-def456', stderr: '' }));
    const result = await runAwsCli('ec2 describe-instances');
    expect(result).toBe('i-abc123\ni-def456');
  });

  it('returns stderr when stdout is empty but stderr has content', async () => {
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: 'CredentialsNotFound' }));
    const result = await runAwsCli('ec2 describe-instances');
    expect(result).toBe('CredentialsNotFound');
  });

  it('returns NO_OUTPUT_MESSAGE when both stdout and stderr are empty', async () => {
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: '' }));
    const result = await runAwsCli('ec2 describe-instances');
    expect(result).toBe(NO_OUTPUT_MESSAGE);
  });

  it('returns error prefix with err.stderr on exec failure', async () => {
    const err = Object.assign(new Error('exit 1'), { stderr: 'AccessDeniedException', stdout: '' });
    stubExec((_cmd, _args, _opts, cb) => cb(err as unknown as Error, { stdout: '', stderr: '' }));
    const result = await runAwsCli('ec2 describe-instances');
    expect(result).toMatch(/aws exited with an error/i);
    expect(result).toContain('AccessDeniedException');
  });

  it('falls back to err.message when err.stderr is absent on exec failure', async () => {
    const err = Object.assign(new Error('command not found: aws'), { stderr: '', stdout: '' });
    stubExec((_cmd, _args, _opts, cb) => cb(err as unknown as Error, { stdout: '', stderr: '' }));
    const result = await runAwsCli('ec2 describe-instances');
    expect(result).toMatch(/aws exited with an error/i);
    expect(result).toContain('command not found: aws');
  });

  it('applies regex redaction rules to successful exec output', async () => {
    stubExec((_cmd, _args, _opts, cb) =>
      cb(null, { stdout: 'AccessKeyId: AKIAIOSFODNN7EXAMPLE', stderr: '' }),
    );
    const rules = compileRules([{ name: 'aws-key', pattern: 'AKIA[0-9A-Z]{16}' }]);
    const result = await runAwsCli('ec2 describe-instances', { regexRedactionRules: rules });
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result).toContain('[REDACTED:aws-key]');
  });

  it('applies regex redaction rules to error output', async () => {
    const err = Object.assign(new Error('fail'), { stderr: 'token=AKIAIOSFODNN7EXAMPLE', stdout: '' });
    stubExec((_cmd, _args, _opts, cb) => cb(err as unknown as Error, { stdout: '', stderr: '' }));
    const rules = compileRules([{ name: 'aws-key', pattern: 'AKIA[0-9A-Z]{16}' }]);
    const result = await runAwsCli('ec2 describe-instances', { regexRedactionRules: rules });
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result).toContain('[REDACTED:aws-key]');
  });
});
