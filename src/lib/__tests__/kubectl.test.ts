import { describe, it, expect } from 'vitest';
import { isJsonOutput, runKubectl, tokenizeArgs } from '../kubectl.ts';

describe('tokenizeArgs', () => {
  it('splits on whitespace', () => {
    expect(tokenizeArgs('get pods -n kube-system')).toEqual(['get', 'pods', '-n', 'kube-system']);
  });

  it('drops a leading "kubectl"', () => {
    expect(tokenizeArgs('kubectl get pods')).toEqual(['get', 'pods']);
  });

  it('honors single and double quotes', () => {
    expect(tokenizeArgs(`get pods -l 'app=web tier=front'`)).toEqual([
      'get',
      'pods',
      '-l',
      'app=web tier=front',
    ]);
    expect(tokenizeArgs('get po -o jsonpath="{.items[*].metadata.name}"')).toEqual([
      'get',
      'po',
      '-o',
      'jsonpath={.items[*].metadata.name}',
    ]);
  });

  it('keeps shell metacharacters as literal tokens (no shell interpretation)', () => {
    // Since execution uses execFile (no shell), these are harmless literals.
    expect(tokenizeArgs('get pods | grep x')).toEqual(['get', 'pods', '|', 'grep', 'x']);
  });

  it('returns an empty array for empty / whitespace-only input', () => {
    expect(tokenizeArgs('')).toEqual([]);
    expect(tokenizeArgs('   \t ')).toEqual([]);
    expect(tokenizeArgs('kubectl')).toEqual([]);
  });

  it('concatenates adjacent quoted and bare segments into one token', () => {
    expect(tokenizeArgs(`get po-"abc"'def'`)).toEqual(['get', 'po-abcdef']);
  });

  it('unescapes \\" and \\\\ inside double quotes', () => {
    expect(tokenizeArgs('get -o "a\\"b\\\\c"')).toEqual(['get', '-o', 'a"b\\c']);
  });

  it('treats backslash as literal-next outside quotes', () => {
    expect(tokenizeArgs('get pod\\ name')).toEqual(['get', 'pod name']);
  });

  it('preserves an empty quoted argument', () => {
    expect(tokenizeArgs(`get -l ""`)).toEqual(['get', '-l', '']);
  });
});

describe('isJsonOutput', () => {
  it('detects -o json and --output json', () => {
    expect(isJsonOutput(['get', 'pods', '-o', 'json'])).toBe(true);
    expect(isJsonOutput(['get', 'pods', '--output', 'json'])).toBe(true);
    expect(isJsonOutput(['get', 'pods', '-o=json'])).toBe(true);
  });

  it('is false for non-json output', () => {
    expect(isJsonOutput(['get', 'pods', '-o', 'yaml'])).toBe(false);
    expect(isJsonOutput(['get', 'pods', '-o', 'wide'])).toBe(false);
    expect(isJsonOutput(['get', 'pods'])).toBe(false);
  });
});

describe('runKubectl (policy enforcement)', () => {
  it('blocks destructive commands without executing them', async () => {
    const result = await runKubectl('delete pod web -n prod');
    expect(result).toMatch(/^BLOCKED:/);
  });

  it('blocks exec (code execution)', async () => {
    const result = await runKubectl('exec mypod -- sh');
    expect(result).toMatch(/^BLOCKED:/);
  });

  it('returns an error for empty input', async () => {
    expect(await runKubectl('   ')).toMatch(/no kubectl arguments/i);
  });

  it('does not block a redundant leading "kubectl" in args', async () => {
    // Validation runs on the same tokenized argv that executes, so a model that
    // includes the word "kubectl" must not trip an "unknown subcommand" block.
    const result = await runKubectl('kubectl delete pod web');
    expect(result).toMatch(/^BLOCKED:/);
    expect(result).toMatch(/destructive/i); // blocked as `delete`, not unknown `kubectl`
  });

  it('blocks all destructive subcommands and code-execution verbs', async () => {
    for (const cmd of ['apply -f x.yaml', 'patch pod web', 'scale deploy/api --replicas=0',
      'rollout restart deploy/api', 'cp pod:/etc/passwd ./', 'port-forward svc/x 8080',
      'attach mypod', 'debug node/n1', 'drain node1', 'cordon node1', 'taint nodes n1 k=v:NoSchedule']) {
      expect(await runKubectl(cmd)).toMatch(/^BLOCKED:/);
    }
  });

  it('blocks the config family and unknown subcommands', async () => {
    expect(await runKubectl('config use-context prod')).toMatch(/^BLOCKED:/);
    expect(await runKubectl('config view --raw')).toMatch(/^BLOCKED:/);
    expect(await runKubectl('proxy --port=8001')).toMatch(/^BLOCKED:/);
  });

  it('blocks auth reconcile but not auth can-i', async () => {
    expect(await runKubectl('auth reconcile -f rbac.yaml')).toMatch(/^BLOCKED:/);
    // can-i is allowed by policy; execution may fail without a cluster, but it
    // must NOT be blocked by the read-only gate.
    expect(await runKubectl('auth can-i list pods')).not.toMatch(/^BLOCKED:/);
  });

  it('lets read-only reads through the policy gate (execution aside)', async () => {
    // No cluster in CI: this returns a kubectl error, never a policy block.
    expect(await runKubectl('get pods -n kube-system')).not.toMatch(/^BLOCKED:/);
    expect(await runKubectl('describe node node1')).not.toMatch(/^BLOCKED:/);
  });
});
