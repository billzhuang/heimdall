import { describe, it, expect } from 'vitest';
import {
  ALLOWED_KUBECTL_COMMANDS,
  DESTRUCTIVE_KUBECTL_COMMANDS,
  isDestructiveCommand,
  parseKubectlCommand,
  validateCommand,
} from '../kubectl-safety.ts';

describe('parseKubectlCommand', () => {
  it('detects non-kubectl commands', () => {
    const result = parseKubectlCommand('ls -la');
    expect(result.isKubectl).toBe(false);
    expect(result.subcommand).toBeNull();
  });

  it('parses a simple subcommand', () => {
    const result = parseKubectlCommand('kubectl get pods');
    expect(result.isKubectl).toBe(true);
    expect(result.subcommand).toBe('get');
    expect(result.args).toEqual(['pods']);
  });

  it('skips global flags that take a value (=form and space form)', () => {
    expect(parseKubectlCommand('kubectl --context=prod get pods').subcommand).toBe('get');
    expect(parseKubectlCommand('kubectl -n kube-system get pods').subcommand).toBe('get');
    expect(parseKubectlCommand('kubectl --namespace foo describe pod x').subcommand).toBe('describe');
  });

  it('does not let a value-taking flag hide a destructive subcommand', () => {
    // `--v 5` consumes "5", so "delete" is still recognized as the subcommand.
    expect(parseKubectlCommand('kubectl --v 5 delete pods').subcommand).toBe('delete');
    expect(isDestructiveCommand('kubectl --v 5 delete pods')).toBe(true);
  });

  it('lowercases the subcommand', () => {
    expect(parseKubectlCommand('kubectl GET pods').subcommand).toBe('get');
  });
});

describe('validateCommand', () => {
  it('allows every documented read-only subcommand', () => {
    for (const cmd of ALLOWED_KUBECTL_COMMANDS) {
      expect(validateCommand(`kubectl ${cmd} something`).allowed).toBe(true);
    }
  });

  it('blocks every destructive subcommand', () => {
    for (const cmd of DESTRUCTIVE_KUBECTL_COMMANDS) {
      const result = validateCommand(`kubectl ${cmd} something`);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/blocked/i);
    }
  });

  it('blocks unknown subcommands by default (default-deny)', () => {
    expect(validateCommand('kubectl proxy').allowed).toBe(false);
  });

  it('gates the auth family to read-only verbs', () => {
    expect(validateCommand('kubectl auth can-i get pods').allowed).toBe(true);
    expect(validateCommand('kubectl auth whoami').allowed).toBe(true);
    // `auth reconcile` creates/updates RBAC objects — must be blocked.
    expect(validateCommand('kubectl auth reconcile -f rbac.yaml').allowed).toBe(false);
    // bare `auth` with no verb is denied.
    expect(validateCommand('kubectl auth').allowed).toBe(false);
  });

  it('blocks the entire config family (kubeconfig-mutating / credential exposure)', () => {
    expect(validateCommand('kubectl config view').allowed).toBe(false);
    expect(validateCommand('kubectl config set-context foo').allowed).toBe(false);
    expect(validateCommand('kubectl config use-context prod').allowed).toBe(false);
  });

  it('rejects non-kubectl commands', () => {
    const result = validateCommand('rm -rf /');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/only kubectl/i);
  });

  it('allows bare kubectl (help)', () => {
    expect(validateCommand('kubectl').allowed).toBe(true);
  });

  it('blocks destructive commands even behind global flags', () => {
    expect(validateCommand('kubectl --context=prod -n default delete pod web').allowed).toBe(false);
  });
});
