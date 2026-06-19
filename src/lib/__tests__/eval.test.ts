import { describe, it, expect } from 'vitest';
import { matchMock } from '../kubectl.ts';

describe('matchMock', () => {
  it('returns null for empty mocks', () => {
    expect(matchMock({}, ['get', 'pods'])).toBeNull();
  });

  it('returns null when no key matches', () => {
    const mocks = { 'describe pod': 'some output' };
    expect(matchMock(mocks, ['get', 'pods'])).toBeNull();
  });

  it('returns the fixture for an exact match', () => {
    const mocks = { 'get pods': 'NAME   READY   STATUS\npod-1  1/1     Running' };
    expect(matchMock(mocks, ['get', 'pods'])).toBe('NAME   READY   STATUS\npod-1  1/1     Running');
  });

  it('matches when argv has more tokens than the key (partial match)', () => {
    const mocks = { 'get pods': 'pod output' };
    expect(matchMock(mocks, ['get', 'pods', '-n', 'default', '-o', 'json'])).toBe('pod output');
  });

  it('selects the most-specific key when multiple keys match', () => {
    const mocks = {
      'get pods': 'generic pod output',
      'get pods default': 'specific namespace output',
    };
    const argv = ['get', 'pods', '-n', 'default'];
    expect(matchMock(mocks, argv)).toBe('specific namespace output');
  });

  it('is case-insensitive for both keys and argv', () => {
    const mocks = { 'Get Pods': 'case insensitive output' };
    expect(matchMock(mocks, ['GET', 'PODS'])).toBe('case insensitive output');
  });

  it('is case-insensitive with mixed case in argv', () => {
    const mocks = { 'describe pod': 'describe output' };
    expect(matchMock(mocks, ['Describe', 'Pod', 'api-pod-abc'])).toBe('describe output');
  });

  it('ignores keys with no tokens (empty or whitespace-only keys)', () => {
    const mocks = {
      '': 'should be ignored',
      '   ': 'also ignored',
      'get pods': 'real output',
    };
    expect(matchMock(mocks, ['get', 'pods'])).toBe('real output');
  });

  it('returns null when key tokens are not all present in argv', () => {
    const mocks = { 'get pods -n kube-system': 'system pods' };
    // argv does not contain "kube-system"
    expect(matchMock(mocks, ['get', 'pods', '-n', 'default'])).toBeNull();
  });

  it('handles a single-token key', () => {
    const mocks = { 'logs': 'log output line 1\nlog output line 2' };
    expect(matchMock(mocks, ['logs', 'api-pod-abc', '-n', 'default'])).toBe('log output line 1\nlog output line 2');
  });

  it('picks the longer matching key over a shorter one', () => {
    const mocks = {
      'describe': 'short key output',
      'describe pvc': 'longer key output',
      'describe pvc data-db-0': 'longest key output',
    };
    const argv = ['describe', 'pvc', 'data-db-0'];
    expect(matchMock(mocks, argv)).toBe('longest key output');
  });

  it('returns null when argv is empty', () => {
    const mocks = { 'get pods': 'pod output' };
    expect(matchMock(mocks, [])).toBeNull();
  });
});
