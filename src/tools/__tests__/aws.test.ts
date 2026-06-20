import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { runAwsCli } = vi.hoisted(() => ({ runAwsCli: vi.fn() }));
vi.mock('../../lib/aws.ts', () => ({
  runAwsCli,
  NO_OUTPUT_MESSAGE: '(command produced no output)',
}));

import { makeAwsCli, awsCli } from '../aws.ts';

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
    const result = await tool.execute({ args: 'ec2 describe-instances --region us-east-1' });
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
    await tool.execute({ args: 'iam list-roles' });
    expect(runAwsCli).toHaveBeenCalledWith('iam list-roles', expect.objectContaining({ audit: auditConfig }));
  });

  it('passes blocked result straight through', async () => {
    runAwsCli.mockResolvedValue('BLOCKED: Destructive command: delete-bucket');
    const tool = makeAwsCli();
    const result = await tool.execute({ args: 'aws s3 rb s3://bucket' });
    expect(result).toMatch(/^BLOCKED:/);
  });
});
