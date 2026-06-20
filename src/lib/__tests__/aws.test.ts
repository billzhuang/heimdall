/**
 * Tests for aws.ts — tokenization and policy decisions only.
 *
 * Real `aws` CLI is NOT invoked. We assert:
 *  1. tokenizeAwsArgs handles quoting, escaping, and strips the leading "aws" token.
 *  2. runAwsCli returns before exec for blocked commands and empty inputs.
 */
import { describe, it, expect } from 'vitest';
import { tokenizeAwsArgs, runAwsCli } from '../aws.ts';
import { BLOCKED_PREFIX } from '../harness.ts';

const BLOCKED_RE = new RegExp(`^${BLOCKED_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');

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
