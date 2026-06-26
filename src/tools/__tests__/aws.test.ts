import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { runAwsCli } = vi.hoisted(() => ({ runAwsCli: vi.fn() }));
vi.mock('../../lib/aws.ts', () => ({
  runAwsCli,
  NO_OUTPUT_MESSAGE: '(command produced no output)',
}));

import { makeAwsCli, awsCli, awsCliPlugin } from '../aws.ts';
import type { CompiledRedactionRule } from '../../lib/regex-redact.ts';
import type { HeimdallConfig } from '../../lib/config.ts';

beforeEach(() => runAwsCli.mockReset());
afterEach(() => vi.unstubAllEnvs());

describe('makeAwsCli', () => {
  it('tool name is aws_cli', () => {
    expect(makeAwsCli().name).toBe('aws_cli');
  });

  it('singleton export has correct name', () => {
    expect(awsCli.name).toBe('aws_cli');
  });

  it('passes args to runAwsCli and returns its result', async () => {
    runAwsCli.mockResolvedValue('i-123 running');
    const tool = makeAwsCli();
    const result = await tool.run({ input: { args: 'ec2 describe-instances --region us-east-1' } });
    expect(result).toBe('i-123 running');
    expect(runAwsCli).toHaveBeenCalledWith(
      'ec2 describe-instances --region us-east-1',
      expect.objectContaining({}),
    );
  });

  it('passes options object into runAwsCli when provided', async () => {
    runAwsCli.mockResolvedValue('ok');
    const auditConfig = { enabled: true, file: '/tmp/audit.log' };
    const tool = makeAwsCli({ audit: auditConfig });
    await tool.run({ input: { args: 'iam list-roles' } });
    expect(runAwsCli).toHaveBeenCalledWith('iam list-roles', expect.objectContaining({ audit: auditConfig }));
  });

  it('passes blocked result straight through', async () => {
    runAwsCli.mockResolvedValue('BLOCKED: Destructive command: delete-bucket');
    const tool = makeAwsCli();
    const result = await tool.run({ input: { args: 'aws s3 rb s3://bucket' } });
    expect(result).toMatch(/^BLOCKED:/);
  });

  it('forwards regexRedactionRules as undefined when none are provided', async () => {
    runAwsCli.mockResolvedValue('ok');
    const tool = makeAwsCli();
    await tool.run({ input: { args: 'ec2 describe-instances' } });
    expect(runAwsCli).toHaveBeenCalledWith(
      'ec2 describe-instances',
      expect.objectContaining({ regexRedactionRules: undefined }),
    );
  });

  it('forwards compiled regex redaction rules to runAwsCli', async () => {
    runAwsCli.mockResolvedValue('ok');
    const rules: CompiledRedactionRule[] = [{ name: 'api-key', re: /AKIA[0-9A-Z]{16}/g }];
    const tool = makeAwsCli(undefined, rules);
    await tool.run({ input: { args: 'iam list-access-keys' } });
    expect(runAwsCli).toHaveBeenCalledWith(
      'iam list-access-keys',
      expect.objectContaining({ regexRedactionRules: rules }),
    );
  });
});

describe('awsCliPlugin', () => {
  it('key is "awsCli"', () => {
    expect(awsCliPlugin.key).toBe('awsCli');
  });

  it('factory passes audit config and rules through to runAwsCli', async () => {
    runAwsCli.mockResolvedValue('ok');
    const auditConfig = { enabled: true, file: '/tmp/audit.log' };
    const rules: CompiledRedactionRule[] = [{ name: 'token', re: /bearer \S+/gi }];
    const tool = awsCliPlugin.factory({ audit: auditConfig } as unknown as HeimdallConfig, rules);
    await tool.run({ input: { args: 's3 list-buckets' } });
    expect(runAwsCli).toHaveBeenCalledWith(
      's3 list-buckets',
      expect.objectContaining({ audit: auditConfig, regexRedactionRules: rules }),
    );
  });
});
