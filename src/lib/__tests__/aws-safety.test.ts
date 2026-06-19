import { describe, it, expect } from 'vitest';
import {
  ALLOWED_AWS_PATTERNS,
  DESTRUCTIVE_AWS_PATTERNS,
  parseAwsCommand,
  validateAwsCommand,
} from '../aws-safety.ts';

describe('parseAwsCommand', () => {
  it('detects non-AWS commands', () => {
    const result = parseAwsCommand('kubectl get pods');
    expect(result.isAws).toBe(false);
    expect(result.service).toBeNull();
    expect(result.subcommand).toBeNull();
  });

  it('parses a simple command', () => {
    const result = parseAwsCommand('aws ec2 describe-instances');
    expect(result.isAws).toBe(true);
    expect(result.service).toBe('ec2');
    expect(result.subcommand).toBe('describe-instances');
  });

  it('parses command with global --region flag (space form)', () => {
    const result = parseAwsCommand('aws --region us-east-1 eks describe-cluster --name my-cluster');
    expect(result.isAws).toBe(true);
    expect(result.service).toBe('eks');
    expect(result.subcommand).toBe('describe-cluster');
  });

  it('parses command with --region= (equals form)', () => {
    const result = parseAwsCommand('aws --region=eu-west-1 iam list-roles');
    expect(result.isAws).toBe(true);
    expect(result.service).toBe('iam');
    expect(result.subcommand).toBe('list-roles');
  });

  it('parses command with --profile flag', () => {
    const result = parseAwsCommand('aws --profile prod s3api list-buckets');
    expect(result.isAws).toBe(true);
    expect(result.service).toBe('s3api');
    expect(result.subcommand).toBe('list-buckets');
  });

  it('parses command with multiple global flags', () => {
    const result = parseAwsCommand('aws --region us-west-2 --output json ec2 describe-security-groups');
    expect(result.isAws).toBe(true);
    expect(result.service).toBe('ec2');
    expect(result.subcommand).toBe('describe-security-groups');
  });

  it('does not let a value-taking flag hide a destructive subcommand', () => {
    // --region consumes "delete-cluster", so the service would be looked up next
    // but really the subcommand "delete-cluster" should be parsed in context
    const result = parseAwsCommand('aws --region us-east-1 eks delete-cluster --name my-cluster');
    expect(result.isAws).toBe(true);
    expect(result.service).toBe('eks');
    expect(result.subcommand).toBe('delete-cluster');
  });

  it('handles bare aws command', () => {
    const result = parseAwsCommand('aws');
    expect(result.isAws).toBe(true);
    expect(result.service).toBeNull();
    expect(result.subcommand).toBeNull();
  });

  it('handles aws with service only', () => {
    const result = parseAwsCommand('aws ec2');
    expect(result.isAws).toBe(true);
    expect(result.service).toBe('ec2');
    expect(result.subcommand).toBeNull();
  });

  it('lowercases service and subcommand', () => {
    const result = parseAwsCommand('aws EC2 DESCRIBE-INSTANCES');
    expect(result.service).toBe('ec2');
    expect(result.subcommand).toBe('describe-instances');
  });
});

describe('validateAwsCommand', () => {
  it('returns null for non-AWS commands', () => {
    expect(validateAwsCommand('kubectl get pods')).toBeNull();
    expect(validateAwsCommand('helm list')).toBeNull();
    expect(validateAwsCommand('')).toBeNull();
  });

  it('allows every read-only allowed-pattern prefix', () => {
    const cases = [
      'aws ec2 describe-instances',
      'aws eks get-token --cluster-name my-cluster',
      'aws iam list-roles',
      'aws cloudwatch get-metric-statistics',
      'aws rds describe-db-instances',
      'aws s3api list-buckets',
      'aws service-quotas list-service-quotas --service-code ec2',
      'aws ecs describe-clusters',
      'aws lambda list-functions',
      'aws elb describe-load-balancers',
      'aws sts get-caller-identity',
    ];
    for (const cmd of cases) {
      const result = validateAwsCommand(cmd);
      expect(result).not.toBeNull();
      expect(result?.allowed).toBe(true);
    }
  });

  it('blocks every documented destructive-pattern prefix', () => {
    const cases = [
      'aws ec2 create-instance',
      'aws rds delete-db-instance --db-instance-identifier mydb',
      'aws ec2 terminate-instances --instance-ids i-123',
      'aws s3api put-bucket-policy --bucket b --policy p',
      'aws eks update-cluster-config --name my-cluster',
      'aws iam attach-role-policy --role-name r --policy-arn a',
      'aws iam detach-role-policy --role-name r --policy-arn a',
      'aws rds modify-db-instance --db-instance-identifier mydb',
      'aws ec2 start-instances --instance-ids i-123',
      'aws ec2 stop-instances --instance-ids i-123',
      'aws rds reboot-db-instance --db-instance-identifier mydb',
      'aws ec2 run-instances --image-id ami-123 --count 1',
      'aws ec2 allocate-address',
      'aws ec2 associate-route-table --route-table-id rt-123 --subnet-id s-123',
      'aws ec2 disassociate-route-table --association-id assoc-123',
      'aws ec2 release-address --allocation-id eipalloc-123',
      'aws ec2 revoke-security-group-ingress --group-id sg-123',
      'aws ec2 authorize-security-group-ingress --group-id sg-123',
    ];
    for (const cmd of cases) {
      const result = validateAwsCommand(cmd);
      expect(result).not.toBeNull();
      expect(result?.allowed).toBe(false);
      expect(result?.reason).toMatch(/blocked/i);
    }
  });

  it('blocks unknown subcommands by default (default-deny)', () => {
    const cases = [
      'aws ec2 unknown-operation',
      'aws eks some-command',
      'aws iam import-certificate',
    ];
    for (const cmd of cases) {
      const result = validateAwsCommand(cmd);
      expect(result).not.toBeNull();
      expect(result?.allowed).toBe(false);
    }
  });

  it('allows bare aws and aws <service> (help output, harmless)', () => {
    expect(validateAwsCommand('aws')?.allowed).toBe(true);
    expect(validateAwsCommand('aws ec2')?.allowed).toBe(true);
  });

  it('blocks destructive commands even with global flags preceding them', () => {
    const result = validateAwsCommand('aws --region us-east-1 --profile prod ec2 delete-security-group --group-id sg-123');
    expect(result?.allowed).toBe(false);
  });

  it('allows read-only commands with global flags preceding them', () => {
    const result = validateAwsCommand('aws --region eu-west-1 --output json ec2 describe-security-groups');
    expect(result?.allowed).toBe(true);
  });
});

describe('DESTRUCTIVE_AWS_PATTERNS and ALLOWED_AWS_PATTERNS constants', () => {
  it('DESTRUCTIVE_AWS_PATTERNS contains expected destructive prefixes', () => {
    expect(DESTRUCTIVE_AWS_PATTERNS).toContain('create-');
    expect(DESTRUCTIVE_AWS_PATTERNS).toContain('delete-');
    expect(DESTRUCTIVE_AWS_PATTERNS).toContain('terminate-');
    expect(DESTRUCTIVE_AWS_PATTERNS).toContain('update-');
    expect(DESTRUCTIVE_AWS_PATTERNS).toContain('run-instances');
  });

  it('ALLOWED_AWS_PATTERNS contains expected read-only prefixes', () => {
    expect(ALLOWED_AWS_PATTERNS).toContain('describe-');
    expect(ALLOWED_AWS_PATTERNS).toContain('get-');
    expect(ALLOWED_AWS_PATTERNS).toContain('list-');
    expect(ALLOWED_AWS_PATTERNS).toContain('show-');
  });
});
