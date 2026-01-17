import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  buildConfigFromState,
  getModelOptions,
} from '../useAppState.js';
import { MODEL_MAP } from '../../constants.js';

describe('stateManagement', () => {
  describe('createInitialState', () => {
    it('should create initial state with default values', () => {
      const state = createInitialState('/path/to/kubeconfig');
      
      expect(state.context).toBeNull();
      expect(state.namespace).toBe('all');
      expect(state.model).toBe('sonnet');
      expect(state.mode).toBe('repl');
      expect(state.activeSelector).toBeNull();
      expect(state.messages).toEqual([]);
      expect(state.kubeconfigPath).toBe('/path/to/kubeconfig');
      expect(state.contexts).toEqual([]);
      expect(state.statusHint).toBeNull();
      expect(state.isRunning).toBe(false);
      expect(state.error).toBeNull();
    });

    it('should use provided kubeconfig path', () => {
      const state = createInitialState('/custom/path');
      expect(state.kubeconfigPath).toBe('/custom/path');
    });
  });

  describe('buildConfigFromState', () => {
    it('should build config from valid state', () => {
      const config = buildConfigFromState('my-context', 'my-namespace', '/path/to/kubeconfig');
      
      expect(config).not.toBeNull();
      expect(config?.context).toBe('my-context');
      expect(config?.namespace).toBe('my-namespace');
      expect(config?.kubeconfig).toBe('/path/to/kubeconfig');
    });

    it('should return null if context is null', () => {
      const config = buildConfigFromState(null, 'my-namespace', '/path/to/kubeconfig');
      expect(config).toBeNull();
    });

    it('should handle "all" namespace', () => {
      const config = buildConfigFromState('my-context', 'all', '/path/to/kubeconfig');
      
      expect(config).not.toBeNull();
      expect(config?.namespace).toBe('all');
    });

    it('should handle "kube-system" namespace', () => {
      const config = buildConfigFromState('my-context', 'kube-system', '/path/to/kubeconfig');
      
      expect(config).not.toBeNull();
      expect(config?.namespace).toBe('kube-system');
    });
  });

  describe('getModelOptions', () => {
    it('should return options for all models in MODEL_MAP', () => {
      const options = getModelOptions();
      const modelKeys = Object.keys(MODEL_MAP);
      
      expect(options.length).toBe(modelKeys.length);
      
      for (const key of modelKeys) {
        const option = options.find(o => o.value === key);
        expect(option).toBeDefined();
        expect(option?.label).toBe(MODEL_MAP[key].label);
      }
    });

    it('should include sonnet option', () => {
      const options = getModelOptions();
      const sonnet = options.find(o => o.value === 'sonnet');
      
      expect(sonnet).toBeDefined();
      expect(sonnet?.label).toContain('Sonnet');
    });

    it('should include opus option', () => {
      const options = getModelOptions();
      const opus = options.find(o => o.value === 'opus');
      
      expect(opus).toBeDefined();
      expect(opus?.label).toContain('Opus');
    });
  });

  describe('state defaults', () => {
    it('initial state should be in repl mode', () => {
      const state = createInitialState('/path');
      expect(state.mode).toBe('repl');
    });

    it('should have correct default model', () => {
      const state = createInitialState('/path');
      expect(state.model).toBe('sonnet');
    });

    it('should have correct default namespace', () => {
      const state = createInitialState('/path');
      expect(state.namespace).toBe('all');
    });

    it('should have null statusHint initially', () => {
      const state = createInitialState('/path');
      expect(state.statusHint).toBeNull();
    });
  });
});
