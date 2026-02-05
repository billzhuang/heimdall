/**
 * Tests for AWS CLI command parsing and validation
 */
import { describe, it, expect } from 'vitest';
import {
  parseAwsCommand,
  validateAwsCommand,
  DESTRUCTIVE_AWS_PATTERNS,
  ALLOWED_AWS_PATTERNS,
} from '../safetyHooks.js';

describe('parseAwsCommand', () => {
  it('should identify AWS commands', () => {
    const result = parseAwsCommand('aws eks describe-cluster --name my-cluster');
    expect(result.isAws).toBe(true);
    expect(result.service).toBe('eks');
    expect(result.subcommand).toBe('describe-cluster');
  });

  it('should handle AWS commands with region flags', () => {
    const result = parseAwsCommand('aws --region us-west-2 ec2 describe-instances');
    expect(result.isAws).toBe(true);
    expect(result.service).toBe('ec2');
    expect(result.subcommand).toBe('describe-instances');
  });

  it('should handle AWS IAM commands', () => {
    const result = parseAwsCommand('aws iam list-users');
    expect(result.isAws).toBe(true);
    expect(result.service).toBe('iam');
    expect(result.subcommand).toBe('list-users');
  });

  it('should return isAws false for non-AWS commands', () => {
    const result = parseAwsCommand('kubectl get pods');
    expect(result.isAws).toBe(false);
    expect(result.service).toBe(null);
    expect(result.subcommand).toBe(null);
  });

  it('should handle AWS command with profile', () => {
    const result = parseAwsCommand('aws --profile prod s3 list-buckets');
    expect(result.isAws).toBe(true);
    expect(result.service).toBe('s3');
    expect(result.subcommand).toBe('list-buckets');
  });

  it('should handle empty AWS command', () => {
    const result = parseAwsCommand('aws');
    expect(result.isAws).toBe(true);
    expect(result.service).toBe(null);
    expect(result.subcommand).toBe(null);
  });

  it('should handle AWS with service but no subcommand', () => {
    const result = parseAwsCommand('aws eks');
    expect(result.isAws).toBe(true);
    expect(result.service).toBe('eks');
    expect(result.subcommand).toBe(null);
  });

  it('should handle complex AWS commands with multiple options', () => {
    const result = parseAwsCommand(
      'aws --region us-east-1 --output json ec2 describe-instances --instance-ids i-1234567890abcdef0'
    );
    expect(result.isAws).toBe(true);
    expect(result.service).toBe('ec2');
    expect(result.subcommand).toBe('describe-instances');
  });
});

describe('validateAwsCommand', () => {
  describe('Read-only commands', () => {
    it('should allow aws eks describe-cluster', () => {
      const result = validateAwsCommand('aws eks describe-cluster --name my-cluster');
      expect(result).not.toBe(null);
      expect(result?.allowed).toBe(true);
      expect(result?.reason).toContain('Read-only');
    });

    it('should allow aws ec2 describe-instances', () => {
      const result = validateAwsCommand('aws ec2 describe-instances');
      expect(result).not.toBe(null);
      expect(result?.allowed).toBe(true);
    });

    it('should allow aws iam list-users', () => {
      const result = validateAwsCommand('aws iam list-users');
      expect(result).not.toBe(null);
      expect(result?.allowed).toBe(true);
    });

    it('should allow aws s3 list-buckets', () => {
      const result = validateAwsCommand('aws s3api list-buckets');
      expect(result).not.toBe(null);
      expect(result?.allowed).toBe(true);
    });

    it('should allow aws rds describe-db-instances', () => {
      const result = validateAwsCommand('aws rds describe-db-instances');
      expect(result).not.toBe(null);
      expect(result?.allowed).toBe(true);
    });

    it('should allow aws cloudwatch get-metric-statistics', () => {
      const result = validateAwsCommand('aws cloudwatch get-metric-statistics');
      expect(result).not.toBe(null);
      expect(result?.allowed).toBe(true);
    });
  });

  describe('Destructive commands', () => {
    it('should block aws ec2 terminate-instances', () => {
      const result = validateAwsCommand('aws ec2 terminate-instances --instance-ids i-123');
      expect(result).not.toBe(null);
      expect(result?.allowed).toBe(false);
      expect(result?.reason).toContain('blocked');
    });

    it('should block aws eks delete-cluster', () => {
      const result = validateAwsCommand('aws eks delete-cluster --name my-cluster');
      expect(result).not.toBe(null);
      expect(result?.allowed).toBe(false);
    });

    it('should block aws iam create-user', () => {
      const result = validateAwsCommand('aws iam create-user --user-name newuser');
      expect(result).not.toBe(null);
      expect(result?.allowed).toBe(false);
    });

    it('should block aws s3 delete-bucket', () => {
      const result = validateAwsCommand('aws s3api delete-bucket --bucket my-bucket');
      expect(result).not.toBe(null);
      expect(result?.allowed).toBe(false);
    });

    it('should block aws rds delete-db-instance', () => {
      const result = validateAwsCommand('aws rds delete-db-instance --db-instance-identifier mydb');
      expect(result).not.toBe(null);
      expect(result?.allowed).toBe(false);
    });

    it('should block aws eks update-cluster-config', () => {
      const result = validateAwsCommand('aws eks update-cluster-config --name my-cluster');
      expect(result).not.toBe(null);
      expect(result?.allowed).toBe(false);
    });

    it('should block aws iam put-user-policy', () => {
      const result = validateAwsCommand('aws iam put-user-policy --user-name user --policy-name policy');
      expect(result).not.toBe(null);
      expect(result?.allowed).toBe(false);
    });

    it('should block aws ec2 run-instances', () => {
      const result = validateAwsCommand('aws ec2 run-instances --image-id ami-123');
      expect(result).not.toBe(null);
      expect(result?.allowed).toBe(false);
    });

    it('should block aws iam attach-user-policy', () => {
      const result = validateAwsCommand('aws iam attach-user-policy --user-name user --policy-arn arn');
      expect(result).not.toBe(null);
      expect(result?.allowed).toBe(false);
    });
  });

  describe('Edge cases', () => {
    it('should return null for non-AWS commands', () => {
      const result = validateAwsCommand('kubectl get pods');
      expect(result).toBe(null);
    });

    it('should allow incomplete AWS commands', () => {
      const result = validateAwsCommand('aws eks');
      expect(result).not.toBe(null);
      expect(result?.allowed).toBe(true);
    });

    it('should block unknown AWS subcommands by default', () => {
      const result = validateAwsCommand('aws eks unknown-command');
      expect(result).not.toBe(null);
      expect(result?.allowed).toBe(false);
      expect(result?.reason).toContain('Unknown');
    });

    it('should handle commands with regions and profiles', () => {
      const result = validateAwsCommand('aws --region us-west-2 --profile prod ec2 describe-instances');
      expect(result).not.toBe(null);
      expect(result?.allowed).toBe(true);
    });
  });
});

describe('AWS patterns', () => {
  it('should have destructive patterns defined', () => {
    expect(DESTRUCTIVE_AWS_PATTERNS.length).toBeGreaterThan(0);
    expect(DESTRUCTIVE_AWS_PATTERNS).toContain('create-');
    expect(DESTRUCTIVE_AWS_PATTERNS).toContain('delete-');
    expect(DESTRUCTIVE_AWS_PATTERNS).toContain('terminate-');
  });

  it('should have allowed patterns defined', () => {
    expect(ALLOWED_AWS_PATTERNS.length).toBeGreaterThan(0);
    expect(ALLOWED_AWS_PATTERNS).toContain('describe-');
    expect(ALLOWED_AWS_PATTERNS).toContain('get-');
    expect(ALLOWED_AWS_PATTERNS).toContain('list-');
  });
});
