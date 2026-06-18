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
});
