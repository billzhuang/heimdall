import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { buildConfigFromState, getModelOptions } from '../useAppState.js';
import { MODEL_MAP, getModelId } from '../../constants.js';

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
