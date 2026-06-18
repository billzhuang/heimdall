import { describe, it, expect } from 'vitest';
import {
  getContextNames,
  mergeKubeconfigs,
  parseKubeconfigContent,
  resolveKubeconfigPath,
} from '../kubeconfig.ts';

const SAMPLE = `
apiVersion: v1
kind: Config
current-context: prod
contexts:
  - name: prod
    context:
      cluster: prod-cluster
      user: prod-user
      namespace: payments
  - name: staging
    context:
      cluster: staging-cluster
      user: staging-user
`;

describe('parseKubeconfigContent', () => {
  it('parses contexts and current-context', () => {
    const parsed = parseKubeconfigContent(SAMPLE);
    expect(parsed).not.toBeNull();
    expect(parsed!.currentContext).toBe('prod');
    expect(parsed!.contexts).toHaveLength(2);
    expect(parsed!.contexts[0]).toEqual({
      name: 'prod',
      cluster: 'prod-cluster',
      user: 'prod-user',
      namespace: 'payments',
    });
  });

  it('returns null for invalid or empty config', () => {
    expect(parseKubeconfigContent('not: [valid')).toBeNull();
    expect(parseKubeconfigContent('apiVersion: v1')).toBeNull();
  });
});

describe('getContextNames', () => {
  it('extracts context names', () => {
    const parsed = parseKubeconfigContent(SAMPLE)!;
    expect(getContextNames(parsed)).toEqual(['prod', 'staging']);
  });
});

describe('mergeKubeconfigs', () => {
  it('merges contexts and keeps the first current-context', () => {
    const a = parseKubeconfigContent(SAMPLE)!;
    const b = parseKubeconfigContent(`
contexts:
  - name: dev
    context:
      cluster: dev
      user: dev
`)!;
    const merged = mergeKubeconfigs([a, b, null]);
    expect(merged!.contexts).toHaveLength(3);
    expect(merged!.currentContext).toBe('prod');
  });

  it('returns null when nothing merges', () => {
    expect(mergeKubeconfigs([null, null])).toBeNull();
  });
});

describe('resolveKubeconfigPath', () => {
  it('prefers an explicit path over the environment', () => {
    expect(resolveKubeconfigPath('/custom/config')).toBe('/custom/config');
  });
});
