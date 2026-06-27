import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  ALLOWED_CDK_COMMANDS,
  CDK_OPTIONS_WITH_VALUE,
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

  it('always blocks destructive subcommands for every CDK_OPTIONS_WITH_VALUE flag in space form', () => {
    const allValueFlags = Array.from(CDK_OPTIONS_WITH_VALUE);
    fc.assert(
      fc.property(
        fc.constantFrom(...DESTRUCTIVE_CDK_COMMANDS),
        fc.constantFrom(...allValueFlags),
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => !/\s/.test(s) && !s.includes('"') && !s.includes("'") && !s.includes('\\')),
        (subcommand, flag, value) => {
          const cmd = `cdk ${flag} ${value} ${subcommand}`;
          const result = validateCdkCommand(cmd);
          expect(result?.allowed).toBe(false);
        },
      ),
    );
  });

  it('never allows destructive subcommand preceded by --key=value equals-form flag', () => {
    const allValueFlags = Array.from(CDK_OPTIONS_WITH_VALUE);
    fc.assert(
      fc.property(
        fc.constantFrom(...DESTRUCTIVE_CDK_COMMANDS),
        fc.constantFrom(...allValueFlags),
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => !/\s/.test(s) && !s.includes('"') && !s.includes("'") && !s.includes('\\')),
        (subcommand, flag, value) => {
          const cmd = `cdk ${flag}=${value} ${subcommand}`;
          const result = validateCdkCommand(cmd);
          expect(result?.allowed).toBe(false);
        },
      ),
    );
  });
});
