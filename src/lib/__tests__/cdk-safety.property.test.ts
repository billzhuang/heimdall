import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  ALLOWED_CDK_COMMANDS,
  DESTRUCTIVE_CDK_COMMANDS,
  validateCdkCommand,
} from '../cdk-safety.ts';

const globalFlags = fc.constantFrom(
  '--profile prod',
  '--output ./cdk.out',
  '--no-color',
  '--app node_app.js',
  '',
);

describe('validateCdkCommand (property-based)', () => {
  it('always blocks destructive subcommands regardless of preceding global flags', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DESTRUCTIVE_CDK_COMMANDS),
        globalFlags,
        (subcommand, flags) => {
          const cmd = `cdk ${flags} ${subcommand}`.replace(/\s+/g, ' ').trim();
          const result = validateCdkCommand(cmd);
          expect(result?.allowed).toBe(false);
        },
      ),
    );
  });

  it('always allows read-only subcommands regardless of preceding global flags', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALLOWED_CDK_COMMANDS),
        globalFlags,
        (subcommand, flags) => {
          const cmd = `cdk ${flags} ${subcommand}`.replace(/\s+/g, ' ').trim();
          const result = validateCdkCommand(cmd);
          expect(result?.allowed).toBe(true);
        },
      ),
    );
  });

  it('never allows a non-cdk command', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('kubectl', 'helm', 'aws', 'terraform', 'bash', 'sh', 'rm'),
        fc.string({ minLength: 1 }),
        (cmd, rest) => {
          const result = validateCdkCommand(`${cmd} ${rest}`);
          expect(result).toBeNull();
        },
      ),
    );
  });
});
