import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  ALLOWED_KUBECTL_COMMANDS,
  DESTRUCTIVE_KUBECTL_COMMANDS,
  validateCommand,
} from '../kubectl-safety.ts';

const globalFlags = fc.constantFrom('--context=prod', '-n default', '--namespace kube-system', '-v 5', '');

describe('validateCommand (property-based)', () => {
  it('always blocks destructive subcommands regardless of preceding global flags', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DESTRUCTIVE_KUBECTL_COMMANDS),
        globalFlags,
        (subcommand, flags) => {
          const command = `kubectl ${flags} ${subcommand} resource`.replace(/\s+/g, ' ').trim();
          expect(validateCommand(command).allowed).toBe(false);
        },
      ),
    );
  });

  it('always allows read-only subcommands regardless of preceding global flags', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALLOWED_KUBECTL_COMMANDS),
        globalFlags,
        (subcommand, flags) => {
          const command = `kubectl ${flags} ${subcommand} resource`.replace(/\s+/g, ' ').trim();
          expect(validateCommand(command).allowed).toBe(true);
        },
      ),
    );
  });

  it('blocks mutating nested verbs in mixed command families', () => {
    // `auth`/`config`/`rollout` are not allowed wholesale; mutating nested verbs must stay blocked.
    fc.assert(
      fc.property(
        fc.constantFrom(
          'auth reconcile -f rbac.yaml',
          'config set-context x',
          'config use-context x',
          'rollout restart deployment/api',
          'rollout undo deployment/api',
          'rollout pause deployment/api',
          'rollout resume deployment/api',
        ),
        globalFlags,
        (tail, flags) => {
          const cmd = `kubectl ${flags} ${tail}`.replace(/\s+/g, ' ').trim();
          expect(validateCommand(cmd).allowed).toBe(false);
        },
      ),
    );
  });

  it('allows read-only nested auth verbs behind any global flags', () => {
    fc.assert(
      fc.property(fc.constantFrom('can-i get pods', 'whoami'), globalFlags, (tail, flags) => {
        const cmd = `kubectl ${flags} auth ${tail}`.replace(/\s+/g, ' ').trim();
        expect(validateCommand(cmd).allowed).toBe(true);
      }),
    );
  });

  it('allows read-only rollout verbs (status, history) behind any global flags', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('status deployment/api', 'history deployment/api'),
        globalFlags,
        (tail, flags) => {
          const cmd = `kubectl ${flags} rollout ${tail}`.replace(/\s+/g, ' ').trim();
          expect(validateCommand(cmd).allowed).toBe(true);
        },
      ),
    );
  });

  it('never allows a non-kubectl command', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const trimmed = input.trim();
        fc.pre(!trimmed.toLowerCase().startsWith('kubectl'));
        expect(validateCommand(input).allowed).toBe(false);
      }),
    );
  });
});
