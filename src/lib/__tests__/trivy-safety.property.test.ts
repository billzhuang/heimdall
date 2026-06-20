import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  ALLOWED_TRIVY_SCAN_TYPES,
  BLOCKED_TRIVY_SUBCOMMANDS,
  TRIVY_OPTIONS_WITH_VALUE,
  validateTrivyCommand,
} from '../trivy-safety.ts';

// Value-taking global flags: each needs a synthetic value token after it.
const valueFlags = Array.from(TRIVY_OPTIONS_WITH_VALUE);
const booleanGlobalFlags = ['--debug', '--quiet', '-q', '--no-progress', '--offline-scan'];

// Arbitrary that generates a value-taking global flag pair (e.g. "--cache-dir /tmp")
const valueFlagArb = fc.constantFrom(...valueFlags).map((f) => `${f} /tmp/val`);
// Arbitrary that generates a boolean flag (no following value)
const boolFlagArb = fc.constantFrom(...booleanGlobalFlags);
// Mix both kinds, or produce the empty string (no flags)
const globalFlagArb = fc.oneof(valueFlagArb, boolFlagArb, fc.constant(''));

describe('validateTrivyCommand (property-based)', () => {
  it('always blocks BLOCKED_TRIVY_SUBCOMMANDS regardless of preceding global flags', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BLOCKED_TRIVY_SUBCOMMANDS),
        globalFlagArb,
        (subcommand, flags) => {
          const cmd = `trivy ${flags} ${subcommand} start`.replace(/\s+/g, ' ').trim();
          expect(validateTrivyCommand(cmd).allowed).toBe(false);
        },
      ),
    );
  });

  it('always allows ALLOWED_TRIVY_SCAN_TYPES behind value-taking global flags', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALLOWED_TRIVY_SCAN_TYPES),
        valueFlagArb,
        (scanType, flagPair) => {
          const cmd = `trivy ${flagPair} ${scanType} nginx:latest`;
          const result = validateTrivyCommand(cmd);
          expect(result.allowed).toBe(true);
          expect(result.scanType).toBe(scanType);
        },
      ),
    );
  });

  it('always allows ALLOWED_TRIVY_SCAN_TYPES behind boolean global flags', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALLOWED_TRIVY_SCAN_TYPES),
        boolFlagArb,
        (scanType, flag) => {
          const cmd = `trivy ${flag} ${scanType} nginx:latest`;
          const result = validateTrivyCommand(cmd);
          expect(result.allowed).toBe(true);
          expect(result.scanType).toBe(scanType);
        },
      ),
    );
  });

  it('always blocks commands containing shell metacharacters', () => {
    const metacharArb = fc.constantFrom('|', ';', '&', '<', '>', '$', '`', '\\');
    fc.assert(
      fc.property(
        fc.constantFrom(...ALLOWED_TRIVY_SCAN_TYPES),
        metacharArb,
        (scanType, meta) => {
          const cmd = `trivy ${scanType} nginx:latest${meta}evil`;
          const result = validateTrivyCommand(cmd);
          expect(result.allowed).toBe(false);
          expect(result.reason).toMatch(/metacharacter/i);
        },
      ),
    );
  });

  it('never allows a non-trivy command', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('kubectl', 'helm', 'curl', 'rm', 'bash', 'sh', 'docker'),
        fc.string({ minLength: 1 }),
        (cmd, rest) => {
          const result = validateTrivyCommand(`${cmd} ${rest}`);
          expect(result.allowed).toBe(false);
        },
      ),
    );
  });

  it('blocks unknown scan types consistently', () => {
    const knownTypes = new Set<string>([
      ...ALLOWED_TRIVY_SCAN_TYPES,
      ...BLOCKED_TRIVY_SUBCOMMANDS,
    ]);
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{4,12}$/).filter((s) => !knownTypes.has(s)),
        (unknownType) => {
          const result = validateTrivyCommand(`trivy ${unknownType} target`);
          expect(result.allowed).toBe(false);
        },
      ),
    );
  });
});
