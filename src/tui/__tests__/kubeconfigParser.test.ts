import { describe, it, expect } from 'vitest';
import {
  parseKubeconfigContent,
  mergeKubeconfigs,
  getContextNames,
  getDefaultKubeconfigPath,
  resolveKubeconfigPath,
} from '../kubeconfigParser.js';

describe('kubeconfigParser', () => {
  describe('parseKubeconfigContent', () => {
    it('should parse valid kubeconfig with single context', () => {
      const content = `
apiVersion: v1
kind: Config
contexts:
  - name: my-cluster
    context:
      cluster: my-cluster
      user: my-user
current-context: my-cluster
`;
      const result = parseKubeconfigContent(content);
      expect(result).not.toBeNull();
      expect(result?.contexts).toHaveLength(1);
      expect(result?.contexts[0].name).toBe('my-cluster');
      expect(result?.contexts[0].cluster).toBe('my-cluster');
      expect(result?.contexts[0].user).toBe('my-user');
      expect(result?.currentContext).toBe('my-cluster');
    });

    it('should parse kubeconfig with multiple contexts', () => {
      const content = `
apiVersion: v1
kind: Config
contexts:
  - name: dev-cluster
    context:
      cluster: dev
      user: dev-user
  - name: prod-cluster
    context:
      cluster: prod
      user: prod-user
      namespace: production
current-context: dev-cluster
`;
      const result = parseKubeconfigContent(content);
      expect(result).not.toBeNull();
      expect(result?.contexts).toHaveLength(2);
      expect(result?.contexts[0].name).toBe('dev-cluster');
      expect(result?.contexts[1].name).toBe('prod-cluster');
      expect(result?.contexts[1].namespace).toBe('production');
    });

    it('should handle kubeconfig without current-context', () => {
      const content = `
apiVersion: v1
kind: Config
contexts:
  - name: my-cluster
    context:
      cluster: my-cluster
      user: my-user
`;
      const result = parseKubeconfigContent(content);
      expect(result).not.toBeNull();
      expect(result?.currentContext).toBeNull();
    });

    it('should return null for invalid YAML', () => {
      const content = 'this is not valid yaml: [';
      const result = parseKubeconfigContent(content);
      expect(result).toBeNull();
    });

    it('should return null for empty contexts', () => {
      const content = `
apiVersion: v1
kind: Config
contexts: []
`;
      const result = parseKubeconfigContent(content);
      expect(result).toBeNull();
    });

    it('should return null for missing contexts', () => {
      const content = `
apiVersion: v1
kind: Config
`;
      const result = parseKubeconfigContent(content);
      expect(result).toBeNull();
    });
  });

  describe('mergeKubeconfigs', () => {
    it('should merge multiple kubeconfigs', () => {
      const config1 = {
        contexts: [
          { name: 'ctx1', cluster: 'c1', user: 'u1' },
        ],
        currentContext: 'ctx1',
      };
      const config2 = {
        contexts: [
          { name: 'ctx2', cluster: 'c2', user: 'u2' },
        ],
        currentContext: 'ctx2',
      };

      const result = mergeKubeconfigs([config1, config2]);
      expect(result).not.toBeNull();
      expect(result?.contexts).toHaveLength(2);
      expect(result?.contexts[0].name).toBe('ctx1');
      expect(result?.contexts[1].name).toBe('ctx2');
    });

    it('should use current-context from first config that has one', () => {
      const config1 = {
        contexts: [{ name: 'ctx1', cluster: 'c1', user: 'u1' }],
        currentContext: 'ctx1',
      };
      const config2 = {
        contexts: [{ name: 'ctx2', cluster: 'c2', user: 'u2' }],
        currentContext: 'ctx2',
      };

      const result = mergeKubeconfigs([config1, config2]);
      expect(result?.currentContext).toBe('ctx1');
    });

    it('should skip null configs', () => {
      const config1 = {
        contexts: [{ name: 'ctx1', cluster: 'c1', user: 'u1' }],
        currentContext: null,
      };

      const result = mergeKubeconfigs([null, config1, null]);
      expect(result).not.toBeNull();
      expect(result?.contexts).toHaveLength(1);
    });

    it('should return null if all configs are null', () => {
      const result = mergeKubeconfigs([null, null]);
      expect(result).toBeNull();
    });

    it('should use current-context from later config if first has none', () => {
      const config1 = {
        contexts: [{ name: 'ctx1', cluster: 'c1', user: 'u1' }],
        currentContext: null,
      };
      const config2 = {
        contexts: [{ name: 'ctx2', cluster: 'c2', user: 'u2' }],
        currentContext: 'ctx2',
      };

      const result = mergeKubeconfigs([config1, config2]);
      expect(result?.currentContext).toBe('ctx2');
    });
  });

  describe('getContextNames', () => {
    it('should return context names', () => {
      const kubeconfig = {
        contexts: [
          { name: 'ctx1', cluster: 'c1', user: 'u1' },
          { name: 'ctx2', cluster: 'c2', user: 'u2' },
        ],
        currentContext: 'ctx1',
      };

      const names = getContextNames(kubeconfig);
      expect(names).toEqual(['ctx1', 'ctx2']);
    });
  });

  describe('path resolution', () => {
    it('getDefaultKubeconfigPath should return path in home directory', () => {
      const path = getDefaultKubeconfigPath();
      expect(path).toContain('.kube/config');
    });

    it('resolveKubeconfigPath should prefer option over env', () => {
      const originalEnv = process.env.KUBECONFIG;
      process.env.KUBECONFIG = '/env/path';
      
      const path = resolveKubeconfigPath('/option/path');
      expect(path).toBe('/option/path');
      
      process.env.KUBECONFIG = originalEnv;
    });

    it('resolveKubeconfigPath should use env if no option', () => {
      const originalEnv = process.env.KUBECONFIG;
      process.env.KUBECONFIG = '/env/path';
      
      const path = resolveKubeconfigPath();
      expect(path).toBe('/env/path');
      
      process.env.KUBECONFIG = originalEnv;
    });
  });
});
