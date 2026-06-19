import { describe, it, expect } from 'vitest';
import {
  ALLOWED_KUBECTL_COMMANDS,
  DESTRUCTIVE_KUBECTL_COMMANDS,
  applyNamespaceLockdown,
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

  it('allows kubectl diff (server-side dry-run, read-only)', () => {
    expect(validateCommand('kubectl diff -f deploy.yaml').allowed).toBe(true);
    expect(validateCommand('kubectl diff -f - <<EOF').allowed).toBe(true);
  });

  it('allows kubectl events (read-only event listing, kubectl ≥ 1.26)', () => {
    expect(validateCommand('kubectl events').allowed).toBe(true);
    expect(validateCommand('kubectl events --for=pod/my-pod').allowed).toBe(true);
    expect(validateCommand('kubectl events --types=Warning -n prod').allowed).toBe(true);
  });

  it('allows kubectl wait (read-only condition polling)', () => {
    expect(validateCommand('kubectl wait --for=condition=Ready pod/web -n prod').allowed).toBe(true);
    expect(validateCommand('kubectl wait --for=condition=Complete job/batch-job').allowed).toBe(true);
    expect(validateCommand('kubectl wait --for=delete deployment/api --timeout=15s').allowed).toBe(true);
  });

  it('blocks bare stdin reads that would hang the agent', () => {
    // Bare "-" as the final token means execFile would block on stdin forever.
    expect(validateCommand('kubectl diff -f -').allowed).toBe(false);
    expect(validateCommand('kubectl diff -f-').allowed).toBe(false);
    expect(validateCommand('kubectl diff --filename=-').allowed).toBe(false);
    expect(validateCommand('kubectl diff --filename -').allowed).toBe(false);
    expect(validateCommand('kubectl get -f -').allowed).toBe(false);
    // Heredoc marker after "-" → kubectl fails with an arg error, not a hang.
    expect(validateCommand('kubectl diff -f - <<EOF').allowed).toBe(true);
  });

  it('gates the auth family to read-only verbs', () => {
    expect(validateCommand('kubectl auth can-i get pods').allowed).toBe(true);
    expect(validateCommand('kubectl auth whoami').allowed).toBe(true);
    // `auth reconcile` creates/updates RBAC objects — must be blocked.
    expect(validateCommand('kubectl auth reconcile -f rbac.yaml').allowed).toBe(false);
    // bare `auth` with no verb is denied.
    expect(validateCommand('kubectl auth').allowed).toBe(false);
  });

  it('allows read-only rollout verbs and blocks mutating ones', () => {
    expect(validateCommand('kubectl rollout status deployment/api').allowed).toBe(true);
    expect(validateCommand('kubectl rollout history deployment/api').allowed).toBe(true);
    // Mutating rollout verbs must be blocked.
    expect(validateCommand('kubectl rollout restart deployment/api').allowed).toBe(false);
    expect(validateCommand('kubectl rollout undo deployment/api').allowed).toBe(false);
    expect(validateCommand('kubectl rollout pause deployment/api').allowed).toBe(false);
    expect(validateCommand('kubectl rollout resume deployment/api').allowed).toBe(false);
    // bare `rollout` with no verb is denied.
    expect(validateCommand('kubectl rollout').allowed).toBe(false);
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

  it('blocks every destructive subcommand hidden behind a value-taking flag', () => {
    for (const cmd of DESTRUCTIVE_KUBECTL_COMMANDS) {
      expect(validateCommand(`kubectl --kubeconfig /tmp/x ${cmd} thing`).allowed).toBe(false);
      expect(validateCommand(`kubectl -n kube-system ${cmd} thing`).allowed).toBe(false);
    }
  });

  it('echoes the trimmed raw command back in the result', () => {
    const result = validateCommand('   kubectl   get pods  ');
    expect(result.command).toBe('kubectl   get pods');
  });

  it('allows auth can-i with extra flags', () => {
    expect(validateCommand('kubectl auth can-i --list -n prod').allowed).toBe(true);
  });
});

describe('parseKubectlCommand — edge cases', () => {
  it('treats empty / whitespace-only input as not-kubectl', () => {
    expect(parseKubectlCommand('').isKubectl).toBe(false);
    expect(parseKubectlCommand('   \t  ').isKubectl).toBe(false);
  });

  it('handles bare kubectl with no subcommand', () => {
    const result = parseKubectlCommand('kubectl');
    expect(result.isKubectl).toBe(true);
    expect(result.subcommand).toBeNull();
    expect(result.args).toEqual([]);
  });

  it('handles a trailing value-taking flag with no following value', () => {
    // `--namespace` consumes the (missing) next token; no subcommand remains.
    const result = parseKubectlCommand('kubectl --namespace');
    expect(result.subcommand).toBeNull();
  });

  it('recognizes the --flag=value form without consuming a token', () => {
    const result = parseKubectlCommand('kubectl --output=json get pods');
    expect(result.subcommand).toBe('get');
  });

  it('captures args after the subcommand', () => {
    const result = parseKubectlCommand('kubectl get pods -n prod -o wide');
    expect(result.subcommand).toBe('get');
    expect(result.args).toEqual(['pods', '-n', 'prod', '-o', 'wide']);
  });

  it('is case-insensitive on the kubectl binary name', () => {
    expect(parseKubectlCommand('KUBECTL get pods').isKubectl).toBe(true);
  });

  it('collapses irregular whitespace between tokens', () => {
    expect(parseKubectlCommand('kubectl\tget   pods').subcommand).toBe('get');
  });
});

describe('isDestructiveCommand', () => {
  it('is false for read-only and non-kubectl commands', () => {
    expect(isDestructiveCommand('kubectl get pods')).toBe(false);
    expect(isDestructiveCommand('ls -la')).toBe(false);
    expect(isDestructiveCommand('kubectl')).toBe(false);
  });

  it('is true for destructive subcommands, even behind flags', () => {
    expect(isDestructiveCommand('kubectl scale deployment api --replicas=3')).toBe(true);
    expect(isDestructiveCommand('kubectl --context=prod rollout restart deploy/api')).toBe(true);
    expect(validateCommand('kubectl --context=prod rollout restart deploy/api').allowed).toBe(false);
  });
});

describe('applyNamespaceLockdown', () => {
  const NS = 'prod';

  it('injects --namespace=<locked> when no namespace flag is present', () => {
    const result = applyNamespaceLockdown(['get', 'pods'], NS);
    expect(result.blocked).toBe(false);
    expect(result.argv).toContain(`--namespace=${NS}`);
  });

  it('leaves argv unchanged when -n already matches the locked namespace', () => {
    const argv = ['get', 'pods', '-n', NS];
    const result = applyNamespaceLockdown(argv, NS);
    expect(result.blocked).toBe(false);
    expect(result.argv).toEqual(argv);
  });

  it('leaves argv unchanged when --namespace=<locked> is already present', () => {
    const argv = ['get', 'pods', `--namespace=${NS}`];
    const result = applyNamespaceLockdown(argv, NS);
    expect(result.blocked).toBe(false);
    expect(result.argv).toEqual(argv);
  });

  it('blocks -A', () => {
    const result = applyNamespaceLockdown(['get', 'pods', '-A'], NS);
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/-A/);
    expect(result.reason).toContain(NS);
  });

  it('blocks --all-namespaces', () => {
    const result = applyNamespaceLockdown(['get', 'pods', '--all-namespaces'], NS);
    expect(result.blocked).toBe(true);
  });

  it('blocks -n with a different namespace', () => {
    const result = applyNamespaceLockdown(['get', 'pods', '-n', 'other'], NS);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('other');
    expect(result.reason).toContain(NS);
  });

  it('blocks --namespace=<other>', () => {
    const result = applyNamespaceLockdown(['get', 'pods', '--namespace=kube-system'], NS);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('kube-system');
  });

  it('blocks --namespace <other> (two-token form)', () => {
    const result = applyNamespaceLockdown(['get', 'pods', '--namespace', 'staging'], NS);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('staging');
  });

  it('does not double-inject when called twice on already-injected argv', () => {
    const first = applyNamespaceLockdown(['get', 'pods'], NS);
    const second = applyNamespaceLockdown(first.argv, NS);
    expect(second.blocked).toBe(false);
    const count = second.argv.filter((a) => a === `--namespace=${NS}`).length;
    expect(count).toBe(1);
  });

  it('returns a new array for injection, does not mutate input', () => {
    const original = ['get', 'pods'];
    const result = applyNamespaceLockdown(original, NS);
    expect(result.blocked).toBe(false);
    expect(original).toHaveLength(2);
    expect(result.argv).not.toBe(original);
  });

  // --- Bypass-vector tests ---

  it('blocks -n=<other> (shorthand with attached = value)', () => {
    const result = applyNamespaceLockdown(['get', 'pods', '-n=other'], NS);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('other');
  });

  it('allows -n=<locked> (shorthand with attached = value matching locked ns)', () => {
    const result = applyNamespaceLockdown(['get', 'pods', `-n=${NS}`], NS);
    expect(result.blocked).toBe(false);
  });

  it('blocks -nother (shorthand with attached value, no equals)', () => {
    const result = applyNamespaceLockdown(['get', 'pods', '-nother'], NS);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('other');
  });

  it('allows -n<locked> (shorthand attached value matching locked ns)', () => {
    const result = applyNamespaceLockdown(['get', 'pods', `-n${NS}`], NS);
    expect(result.blocked).toBe(false);
  });

  it('blocks -An (grouped shorthand containing A)', () => {
    const result = applyNamespaceLockdown(['get', 'pods', '-An', NS], NS);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('-A');
  });

  it('blocks -nA (grouped shorthand where A is not first)', () => {
    const result = applyNamespaceLockdown(['get', 'pods', '-nA'], NS);
    // 'A' is part of the namespace value — but 'A' as a namespace value ≠ lockedNs
    // or it could be interpreted as grouped (depends on kubectl's pflag).
    // Either way it should not match lockedNs and be blocked.
    expect(result.blocked).toBe(true);
  });

  it('blocks mixed flags that bypass via overwrite (--namespace=<locked> then -n=other)', () => {
    const result = applyNamespaceLockdown(['get', 'pods', `--namespace=${NS}`, '-n=other'], NS);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('other');
  });

  it('blocks mixed flags in reverse order (-n=other then --namespace=<locked>)', () => {
    const result = applyNamespaceLockdown(['get', 'pods', '-n=other', `--namespace=${NS}`], NS);
    expect(result.blocked).toBe(true);
  });
});
