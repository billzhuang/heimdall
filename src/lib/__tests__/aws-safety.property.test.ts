import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  ALLOWED_AWS_PATTERNS,
  DESTRUCTIVE_AWS_PATTERNS,
  validateAwsCommand,
} from '../aws-safety.ts';

const POST_SERVICE_OPTIONS = fc.constantFrom(
  '--output json',
  '--query "Instances"',
  '--profile dev',
  '--output text --query "Reservations"',
);

const globalFlags = fc.constantFrom(
  '--region us-east-1',
  '--profile prod',
  '--output json',
  '--region us-west-2 --output text',
  '',
);

describe('validateAwsCommand (property-based)', () => {
  it('always blocks destructive subcommands regardless of preceding global flags', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DESTRUCTIVE_AWS_PATTERNS),
        fc.constantFrom('ec2', 'eks', 'iam', 'rds', 's3api', 'lambda'),
        globalFlags,
        (pattern, service, flags) => {
          // Build a realistic subcommand from the pattern
          const subcommand = pattern === 'run-instances' ? 'run-instances' : `${pattern}resource`;
          const cmd = `aws ${flags} ${service} ${subcommand}`.replace(/\s+/g, ' ').trim();
          const result = validateAwsCommand(cmd);
          expect(result?.allowed).toBe(false);
        },
      ),
    );
  });

  it('always allows read-only subcommands regardless of preceding global flags', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALLOWED_AWS_PATTERNS),
        fc.constantFrom('ec2', 'eks', 'iam', 'rds', 's3api', 'lambda'),
        globalFlags,
        (pattern, service, flags) => {
          const subcommand = `${pattern}resources`;
          const cmd = `aws ${flags} ${service} ${subcommand}`.replace(/\s+/g, ' ').trim();
          const result = validateAwsCommand(cmd);
          expect(result?.allowed).toBe(true);
        },
      ),
    );
  });

  it('never allows a non-aws command', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('kubectl', 'helm', 'curl', 'rm', 'bash', 'sh'),
        fc.string({ minLength: 1 }),
        (cmd, rest) => {
          const result = validateAwsCommand(`${cmd} ${rest}`);
          expect(result).toBeNull();
        },
      ),
    );
  });

  it('still allows read-only subcommands when an option-with-value is inserted after service', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALLOWED_AWS_PATTERNS),
        fc.constantFrom('ec2', 'eks', 'iam', 'rds', 's3api', 'lambda'),
        POST_SERVICE_OPTIONS,
        (pattern, service, postServiceOpt) => {
          const subcommand = `${pattern}resources`;
          const cmd = `aws ${service} ${postServiceOpt} ${subcommand}`.replace(/\s+/g, ' ').trim();
          const result = validateAwsCommand(cmd);
          expect(result?.allowed).toBe(true);
        },
      ),
    );
  });

  it('still blocks destructive subcommands when an option-with-value is inserted after service', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DESTRUCTIVE_AWS_PATTERNS),
        fc.constantFrom('ec2', 'eks', 'iam', 'rds', 's3api', 'lambda'),
        POST_SERVICE_OPTIONS,
        (pattern, service, postServiceOpt) => {
          const subcommand = pattern === 'run-instances' ? 'run-instances' : `${pattern}resource`;
          const cmd = `aws ${service} ${postServiceOpt} ${subcommand}`.replace(/\s+/g, ' ').trim();
          const result = validateAwsCommand(cmd);
          expect(result?.allowed).toBe(false);
        },
      ),
    );
  });
});
