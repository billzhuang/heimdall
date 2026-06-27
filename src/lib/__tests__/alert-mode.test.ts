import { describe, it, expect } from 'vitest';
import { addKubectlResultIfValid } from '../../alert-mode.ts';
import { BLOCKED_PREFIX } from '../harness.ts';

describe('addKubectlResultIfValid', () => {
  it('appends a formatted entry for a valid non-error result', () => {
    const parts: string[] = [];
    addKubectlResultIfValid(parts, 'kubectl get pods -n prod', 'NAME   READY\npod-1  1/1');
    expect(parts).toEqual(['--- kubectl get pods -n prod ---\nNAME   READY\npod-1  1/1']);
  });

  it('does not append when result is an empty string', () => {
    const parts: string[] = [];
    addKubectlResultIfValid(parts, 'kubectl get pods -n prod', '');
    expect(parts).toHaveLength(0);
  });

  it('does not append when result starts with "Error:"', () => {
    const parts: string[] = [];
    addKubectlResultIfValid(parts, 'kubectl get pods -n prod', 'Error: namespace not found');
    expect(parts).toHaveLength(0);
  });

  it('does not append when result starts with BLOCKED_PREFIX', () => {
    const parts: string[] = [];
    addKubectlResultIfValid(parts, 'kubectl delete pods', `${BLOCKED_PREFIX}delete is not allowed`);
    expect(parts).toHaveLength(0);
  });

  it('appends to existing parts without disturbing them', () => {
    const parts = ['--- existing ---\ndata'];
    addKubectlResultIfValid(parts, 'kubectl get ns', 'default\nprod');
    expect(parts).toEqual([
      '--- existing ---\ndata',
      '--- kubectl get ns ---\ndefault\nprod',
    ]);
  });

  it('skips error and blocked entries and accumulates only valid ones', () => {
    const parts: string[] = [];
    addKubectlResultIfValid(parts, 'label-1', 'output-1');
    addKubectlResultIfValid(parts, 'label-2', 'Error: skip this');
    addKubectlResultIfValid(parts, 'label-3', `${BLOCKED_PREFIX}blocked`);
    addKubectlResultIfValid(parts, 'label-4', 'output-4');
    expect(parts).toEqual([
      '--- label-1 ---\noutput-1',
      '--- label-4 ---\noutput-4',
    ]);
  });
});
