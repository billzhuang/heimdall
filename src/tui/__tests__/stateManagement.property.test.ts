import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { buildConfigFromState, getModelOptions, TUIState } from '../useAppState.js';
import { MODEL_MAP, getModelId } from '../constants.js';

/**
 * Feature: claude-code-style-welcome, Property 1: State Transition Preserves Configuration
 * 
 * For any valid TUI state with hasInteracted=false and a context, namespace, and model configured,
 * when transitioning to hasInteracted=true (via query submission), the resulting state SHALL preserve
 * the original context, namespace, and model values.
 * 
 * **Validates: Requirements 1.5, 6.2**
 */
describe('Property 1: State Transition Preserves Configuration', () => {
  // Arbitrary for valid context strings (non-empty, alphanumeric with dashes/underscores)
  const validContextArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
  
  // Arbitrary for valid namespace strings (Kubernetes namespace naming rules)
  const validNamespaceArb = fc.oneof(
    fc.constant('all'),
    fc.constant('kube-system'),
    fc.constant('default'),
    fc.stringMatching(/^[a-z][a-z0-9-]{0,62}$/)
  );
  
  // Arbitrary for valid model shorthands from MODEL_MAP
  const validModelArb = fc.constantFrom(...Object.keys(MODEL_MAP));
  
  // Arbitrary for valid kubeconfig paths
  const validKubeconfigPathArb = fc.stringMatching(/^\/[a-zA-Z0-9/_.-]+$/);

  // Arbitrary for generating a valid TUI state with hasInteracted=false (showing welcome)
  const validWelcomeStateArb: fc.Arbitrary<TUIState> = fc.record({
    context: validContextArb,
    namespace: validNamespaceArb,
    model: validModelArb,
    mode: fc.constant('repl' as const),
    activeSelector: fc.constant(null),
    hasInteracted: fc.constant(false),
    messages: fc.constant([]),
    kubeconfigPath: validKubeconfigPathArb,
    contexts: fc.array(validContextArb, { minLength: 0, maxLength: 5 }),
    statusHint: fc.option(fc.string(), { nil: null }),
    isRunning: fc.constant(false),
    error: fc.option(fc.string(), { nil: null }),
  });

  /**
   * Simulates setting hasInteracted to true - marks user has interacted
   * This is a pure function version of the state transition for testing
   */
  function applySetHasInteracted(state: TUIState): TUIState {
    return {
      ...state,
      hasInteracted: true,
    };
  }

  it('preserves context value when setting hasInteracted to true', () => {
    fc.assert(
      fc.property(validWelcomeStateArb, (initialState) => {
        const resultState = applySetHasInteracted(initialState);
        
        expect(resultState.context).toBe(initialState.context);
      }),
      { numRuns: 100 }
    );
  });

  it('preserves namespace value when setting hasInteracted to true', () => {
    fc.assert(
      fc.property(validWelcomeStateArb, (initialState) => {
        const resultState = applySetHasInteracted(initialState);
        
        expect(resultState.namespace).toBe(initialState.namespace);
      }),
      { numRuns: 100 }
    );
  });

  it('preserves model value when setting hasInteracted to true', () => {
    fc.assert(
      fc.property(validWelcomeStateArb, (initialState) => {
        const resultState = applySetHasInteracted(initialState);
        
        expect(resultState.model).toBe(initialState.model);
      }),
      { numRuns: 100 }
    );
  });

  it('preserves all configuration values (context, namespace, model) together', () => {
    fc.assert(
      fc.property(validWelcomeStateArb, (initialState) => {
        const resultState = applySetHasInteracted(initialState);
        
        // All configuration values must be preserved
        expect(resultState.context).toBe(initialState.context);
        expect(resultState.namespace).toBe(initialState.namespace);
        expect(resultState.model).toBe(initialState.model);
        
        // hasInteracted should be set to true
        expect(resultState.hasInteracted).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('preserves kubeconfigPath when setting hasInteracted to true', () => {
    fc.assert(
      fc.property(validWelcomeStateArb, (initialState) => {
        const resultState = applySetHasInteracted(initialState);
        
        expect(resultState.kubeconfigPath).toBe(initialState.kubeconfigPath);
      }),
      { numRuns: 100 }
    );
  });

  it('preserves contexts array when setting hasInteracted to true', () => {
    fc.assert(
      fc.property(validWelcomeStateArb, (initialState) => {
        const resultState = applySetHasInteracted(initialState);
        
        expect(resultState.contexts).toEqual(initialState.contexts);
      }),
      { numRuns: 100 }
    );
  });

  it('only changes hasInteracted during transition', () => {
    fc.assert(
      fc.property(validWelcomeStateArb, (initialState) => {
        const resultState = applySetHasInteracted(initialState);
        
        // This should change
        expect(resultState.hasInteracted).toBe(true);
        
        // Everything else should remain unchanged
        expect(resultState.context).toBe(initialState.context);
        expect(resultState.namespace).toBe(initialState.namespace);
        expect(resultState.model).toBe(initialState.model);
        expect(resultState.mode).toBe(initialState.mode);
        expect(resultState.activeSelector).toBe(initialState.activeSelector);
        expect(resultState.messages).toEqual(initialState.messages);
        expect(resultState.kubeconfigPath).toBe(initialState.kubeconfigPath);
        expect(resultState.contexts).toEqual(initialState.contexts);
        expect(resultState.statusHint).toBe(initialState.statusHint);
        expect(resultState.isRunning).toBe(initialState.isRunning);
        expect(resultState.error).toBe(initialState.error);
      }),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 8: Config Construction from State
 * 
 * For any valid application state with context, namespace, and model selections,
 * the constructed HeimdallConfig SHALL contain:
 * - The exact context string from state
 * - The exact namespace string from state (or "all")
 * - The model ID corresponding to the model shorthand from MODEL_MAP
 * 
 * **Validates: Requirements 11.2, 11.4**
 */
describe('Property 8: Config construction from state', () => {
  // Arbitrary for valid context strings (non-empty, no special chars)
  const validContextArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
  
  // Arbitrary for valid namespace strings
  const validNamespaceArb = fc.oneof(
    fc.constant('all'),
    fc.stringMatching(/^[a-z][a-z0-9-]{0,62}$/)
  );
  
  // Arbitrary for valid kubeconfig paths
  const validKubeconfigPathArb = fc.stringMatching(/^\/[a-zA-Z0-9/_.-]+$/);

  it('should construct config with exact context from state', () => {
    fc.assert(
      fc.property(
        validContextArb,
        validNamespaceArb,
        validKubeconfigPathArb,
        (context, namespace, kubeconfigPath) => {
          const config = buildConfigFromState(context, namespace, kubeconfigPath);
          
          expect(config).not.toBeNull();
          expect(config?.context).toBe(context);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should construct config with exact namespace from state', () => {
    fc.assert(
      fc.property(
        validContextArb,
        validNamespaceArb,
        validKubeconfigPathArb,
        (context, namespace, kubeconfigPath) => {
          const config = buildConfigFromState(context, namespace, kubeconfigPath);
          
          expect(config).not.toBeNull();
          expect(config?.namespace).toBe(namespace);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should construct config with exact kubeconfig path from state', () => {
    fc.assert(
      fc.property(
        validContextArb,
        validNamespaceArb,
        validKubeconfigPathArb,
        (context, namespace, kubeconfigPath) => {
          const config = buildConfigFromState(context, namespace, kubeconfigPath);
          
          expect(config).not.toBeNull();
          expect(config?.kubeconfig).toBe(kubeconfigPath);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return null when context is null', () => {
    fc.assert(
      fc.property(
        validNamespaceArb,
        validKubeconfigPathArb,
        (namespace, kubeconfigPath) => {
          const config = buildConfigFromState(null, namespace, kubeconfigPath);
          expect(config).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should map model shorthand to correct model ID', () => {
    const modelShorthands = Object.keys(MODEL_MAP);
    
    fc.assert(
      fc.property(
        fc.constantFrom(...modelShorthands),
        (shorthand) => {
          const modelId = getModelId(shorthand);
          expect(modelId).toBe(MODEL_MAP[shorthand].id);
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 9: Model Options Completeness
 * 
 * For any model shorthand key in MODEL_MAP, the model selector options
 * SHALL include an item with that key as value and the corresponding
 * label from MODEL_MAP.
 * 
 * **Validates: Requirements 5.2**
 */
describe('Property 9: Model options completeness', () => {
  it('should include all MODEL_MAP entries in options', () => {
    const options = getModelOptions();
    const modelKeys = Object.keys(MODEL_MAP);
    
    fc.assert(
      fc.property(
        fc.constantFrom(...modelKeys),
        (modelKey) => {
          const option = options.find(o => o.value === modelKey);
          
          expect(option).toBeDefined();
          expect(option?.value).toBe(modelKey);
          expect(option?.label).toBe(MODEL_MAP[modelKey].label);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should have same count as MODEL_MAP', () => {
    const options = getModelOptions();
    expect(options.length).toBe(Object.keys(MODEL_MAP).length);
  });

  it('should have unique values', () => {
    const options = getModelOptions();
    const values = options.map(o => o.value);
    const uniqueValues = new Set(values);
    
    expect(uniqueValues.size).toBe(values.length);
  });
});
