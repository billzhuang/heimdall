/**
 * Property-based tests for agentRunner module
 * - Session state management properties
 * - Safety hooks command classification properties
 * - MaxTurns configuration properties
 *
 * Uses fast-check for property-based testing
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { getCurrentSessionId, clearCurrentSession } from '../agentRunner.js';
import {
  parseKubectlCommand,
  isDestructiveCommand,
  validateCommand,
  DESTRUCTIVE_KUBECTL_COMMANDS,
  ALLOWED_KUBECTL_COMMANDS,
  DEFAULT_MAX_TURNS,
} from '../safetyHooks.js';

// =============================================================================
// Generators for kubectl commands
// =============================================================================

const destructiveSubcommand = fc.constantFrom(...DESTRUCTIVE_KUBECTL_COMMANDS);
const allowedSubcommand = fc.constantFrom(...ALLOWED_KUBECTL_COMMANDS);

const kubectlPrefix = fc.constantFrom(
  'kubectl',
  'kubectl --context=prod',
  'kubectl --context=staging',
  'kubectl -n default',
  'kubectl -n kube-system',
  'kubectl --context=prod -n default'
);

const safeArg = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-z0-9][a-z0-9-_.]*$/i.test(s));

const destructiveKubectlCommand = fc
  .tuple(kubectlPrefix, destructiveSubcommand, fc.array(safeArg, { minLength: 0, maxLength: 3 }))
  .map(
    ([prefix, subcommand, args]) =>
      `${prefix} ${subcommand}${args.length > 0 ? ' ' + args.join(' ') : ''}`
  );

const allowedKubectlCommand = fc
  .tuple(kubectlPrefix, allowedSubcommand, fc.array(safeArg, { minLength: 0, maxLength: 3 }))
  .map(
    ([prefix, subcommand, args]) =>
      `${prefix} ${subcommand}${args.length > 0 ? ' ' + args.join(' ') : ''}`
  );

const nonKubectlCommand = fc
  .tuple(
    fc.constantFrom('ls', 'cat', 'echo', 'grep', 'find', 'pwd', 'whoami', 'date', 'hostname'),
    fc.array(safeArg, { minLength: 0, maxLength: 3 })
  )
  .map(([cmd, args]) => `${cmd}${args.length > 0 ? ' ' + args.join(' ') : ''}`);

// =============================================================================
// Session Management Properties
// =============================================================================

describe('Property: Session state management', () => {
  beforeEach(() => {
    clearCurrentSession();
  });

  it('should always return null after clearCurrentSession', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), (clearCount) => {
        for (let i = 0; i < clearCount; i++) {
          clearCurrentSession();
        }
        expect(getCurrentSessionId()).toBeNull();
      }),
      { numRuns: 50 }
    );
  });

  it('should be idempotent - multiple clears have same effect as one', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (times) => {
        clearCurrentSession();
        const afterOne = getCurrentSessionId();

        for (let i = 0; i < times; i++) {
          clearCurrentSession();
        }
        const afterMany = getCurrentSessionId();

        expect(afterMany).toBe(afterOne);
        expect(afterMany).toBeNull();
      }),
      { numRuns: 50 }
    );
  });
});

// =============================================================================
// Command Classification Properties
// **Validates: Requirements 1.1, 1.2, 1.3, 1.7**
// =============================================================================

describe('Property: Command Classification', () => {
  it('should block all destructive kubectl commands', () => {
    fc.assert(
      fc.property(destructiveKubectlCommand, (command) => {
        const result = validateCommand(command);
        expect(result.allowed).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('should allow all read-only kubectl commands', () => {
    fc.assert(
      fc.property(allowedKubectlCommand, (command) => {
        const result = validateCommand(command);
        expect(result.allowed).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should allow all non-kubectl commands', () => {
    fc.assert(
      fc.property(nonKubectlCommand, (command) => {
        const result = validateCommand(command);
        expect(result.allowed).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('isDestructiveCommand should match validateCommand for kubectl commands', () => {
    fc.assert(
      fc.property(fc.oneof(destructiveKubectlCommand, allowedKubectlCommand), (command) => {
        const isDestructive = isDestructiveCommand(command);
        const validation = validateCommand(command);
        expect(isDestructive).toBe(!validation.allowed);
      }),
      { numRuns: 100 }
    );
  });
});

// =============================================================================
// Blocked Command Handling Properties
// **Validates: Requirements 1.4, 1.5**
// =============================================================================

describe('Property: Blocked Command Handling', () => {
  it('should include original command in blocked result', () => {
    fc.assert(
      fc.property(destructiveKubectlCommand, (command) => {
        const result = validateCommand(command);
        expect(result.command).toBe(command);
      }),
      { numRuns: 100 }
    );
  });

  it('should include reason with manual run suggestion for blocked commands', () => {
    fc.assert(
      fc.property(destructiveKubectlCommand, (command) => {
        const result = validateCommand(command);
        expect(result.reason).toBeTruthy();
        expect(result.reason).toContain('Run manually');
      }),
      { numRuns: 100 }
    );
  });

  it('should include the blocked subcommand in the reason', () => {
    fc.assert(
      fc.property(destructiveKubectlCommand, (command) => {
        const result = validateCommand(command);
        expect(result.subcommand).toBeTruthy();
        expect(result.reason).toContain(result.subcommand!);
      }),
      { numRuns: 100 }
    );
  });
});

// =============================================================================
// Kubectl Command Parsing Properties
// **Validates: Requirements 1.6**
// =============================================================================

describe('Property: Kubectl Command Parsing', () => {
  it('should correctly identify kubectl commands', () => {
    fc.assert(
      fc.property(fc.oneof(destructiveKubectlCommand, allowedKubectlCommand), (command) => {
        const result = parseKubectlCommand(command);
        expect(result.isKubectl).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should correctly identify non-kubectl commands', () => {
    fc.assert(
      fc.property(nonKubectlCommand, (command) => {
        const result = parseKubectlCommand(command);
        expect(result.isKubectl).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('should extract correct subcommand from destructive commands', () => {
    fc.assert(
      fc.property(fc.tuple(kubectlPrefix, destructiveSubcommand), ([prefix, subcommand]) => {
        const command = `${prefix} ${subcommand} some-resource`;
        const result = parseKubectlCommand(command);
        expect(result.subcommand).toBe(subcommand);
      }),
      { numRuns: 100 }
    );
  });

  it('should extract correct subcommand from allowed commands', () => {
    fc.assert(
      fc.property(fc.tuple(kubectlPrefix, allowedSubcommand), ([prefix, subcommand]) => {
        const command = `${prefix} ${subcommand} some-resource`;
        const result = parseKubectlCommand(command);
        expect(result.subcommand).toBe(subcommand);
      }),
      { numRuns: 100 }
    );
  });

  it('should preserve raw command in result', () => {
    fc.assert(
      fc.property(
        fc.oneof(destructiveKubectlCommand, allowedKubectlCommand, nonKubectlCommand),
        (command) => {
          const result = parseKubectlCommand(command);
          expect(result.rawCommand).toBe(command);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// =============================================================================
// MaxTurns Configuration Properties
// **Validates: Requirements 4.1, 4.4, 4.5**
// =============================================================================

describe('Property: MaxTurns Configuration', () => {
  function getEffectiveMaxTurns(maxTurns: number | undefined): number | undefined {
    const effective = maxTurns ?? DEFAULT_MAX_TURNS;
    return effective > 0 ? effective : undefined;
  }

  it('should return exact value for positive integers', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), (maxTurns) => {
        const result = getEffectiveMaxTurns(maxTurns);
        expect(result).toBe(maxTurns);
      }),
      { numRuns: 100 }
    );
  });

  it('should return undefined for zero and negative integers', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 0 }), (maxTurns) => {
        const result = getEffectiveMaxTurns(maxTurns);
        expect(result).toBeUndefined();
      }),
      { numRuns: 100 }
    );
  });

  it('should return default for undefined', () => {
    const result = getEffectiveMaxTurns(undefined);
    expect(result).toBe(DEFAULT_MAX_TURNS);
    expect(result).toBe(15);
  });

  it('should always return positive number or undefined', () => {
    fc.assert(
      fc.property(fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: undefined }), (maxTurns) => {
        const result = getEffectiveMaxTurns(maxTurns);
        expect(result === undefined || result > 0).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});
