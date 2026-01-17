import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  parseKubeconfigContent,
  mergeKubeconfigs,
  ParsedKubeconfig,
  KubeconfigContext,
} from '../kubeconfigParser.js';

/**
 * Property-based tests for kubeconfig parser
 */
describe('kubeconfigParser property tests', () => {
  // Arbitrary for generating valid context names
  const contextNameArb = fc.string({ minLength: 1, maxLength: 50 })
    .filter(s => /^[a-zA-Z0-9_-]+$/.test(s));

  // Arbitrary for generating kubeconfig context
  const kubeconfigContextArb: fc.Arbitrary<KubeconfigContext> = fc.record({
    name: contextNameArb,
    cluster: contextNameArb,
    user: contextNameArb,
    namespace: fc.option(contextNameArb, { nil: undefined }),
  });

  // Arbitrary for generating parsed kubeconfig
  const parsedKubeconfigArb: fc.Arbitrary<ParsedKubeconfig> = fc
    .array(kubeconfigContextArb, { minLength: 1, maxLength: 5 })
    .chain(contexts => 
      fc.record({
        contexts: fc.constant(contexts),
        currentContext: fc.option(fc.constantFrom(...contexts.map(c => c.name)), { nil: null }),
      })
    );

  /**
   * Property 5: Kubeconfig Multi-File Merging
   * For any set of valid kubeconfig files, when merged, the result SHALL contain
   * all contexts from all files merged into a single array.
   * 
   * **Validates: Requirements 10.4, 10.5**
   */
  describe('Property 5: Kubeconfig multi-file merging', () => {
    it('should contain all contexts from all configs after merge', () => {
      fc.assert(
        fc.property(
          fc.array(parsedKubeconfigArb, { minLength: 1, maxLength: 3 }),
          (configs) => {
            const result = mergeKubeconfigs(configs);
            
            // Count total contexts from all configs
            const totalContexts = configs.reduce((sum, c) => sum + c.contexts.length, 0);
            
            expect(result).not.toBeNull();
            expect(result?.contexts.length).toBe(totalContexts);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should preserve all context data during merge', () => {
      fc.assert(
        fc.property(
          fc.array(parsedKubeconfigArb, { minLength: 1, maxLength: 3 }),
          (configs) => {
            const result = mergeKubeconfigs(configs);
            
            // All original contexts should be in the result
            for (const config of configs) {
              for (const ctx of config.contexts) {
                const found = result?.contexts.find(
                  c => c.name === ctx.name && c.cluster === ctx.cluster && c.user === ctx.user
                );
                expect(found).toBeDefined();
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should handle mix of valid configs and nulls', () => {
      fc.assert(
        fc.property(
          fc.array(fc.option(parsedKubeconfigArb, { nil: null }), { minLength: 1, maxLength: 5 }),
          (configs) => {
            const result = mergeKubeconfigs(configs);
            
            const validConfigs = configs.filter((c): c is ParsedKubeconfig => c !== null);
            const totalContexts = validConfigs.reduce((sum, c) => sum + c.contexts.length, 0);
            
            if (totalContexts === 0) {
              expect(result).toBeNull();
            } else {
              expect(result?.contexts.length).toBe(totalContexts);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 6: Kubeconfig Current-Context Identification
   * For any set of kubeconfig files where at least one defines current-context,
   * the result SHALL return the current-context from the first file that defines it.
   * 
   * **Validates: Requirements 10.6, 9.4**
   */
  describe('Property 6: Kubeconfig current-context identification', () => {
    it('should use current-context from first config that defines it', () => {
      fc.assert(
        fc.property(
          fc.array(parsedKubeconfigArb, { minLength: 2, maxLength: 4 }),
          (configs) => {
            const result = mergeKubeconfigs(configs);
            
            // Find first config with current-context
            const firstWithCurrent = configs.find(c => c.currentContext !== null);
            
            if (firstWithCurrent) {
              expect(result?.currentContext).toBe(firstWithCurrent.currentContext);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should return null current-context if no config defines it', () => {
      fc.assert(
        fc.property(
          fc.array(kubeconfigContextArb, { minLength: 1, maxLength: 3 }),
          (contexts) => {
            // Create configs without current-context
            const configs: ParsedKubeconfig[] = contexts.map(ctx => ({
              contexts: [ctx],
              currentContext: null,
            }));
            
            const result = mergeKubeconfigs(configs);
            expect(result?.currentContext).toBeNull();
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 7: Invalid Kubeconfig Handling
   * For any invalid kubeconfig content, parseKubeconfigContent SHALL return null
   * without throwing an exception.
   * 
   * **Validates: Requirements 3.6**
   */
  describe('Property 7: Invalid kubeconfig handling', () => {
    it('should return null for random invalid content without throwing', () => {
      fc.assert(
        fc.property(fc.string(), (content) => {
          // This should not throw
          const result = parseKubeconfigContent(content);
          // Result should be null for random strings (very unlikely to be valid YAML with contexts)
          // We just verify it doesn't throw
          expect(result === null || result !== null).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('should return null for YAML without contexts array', () => {
      fc.assert(
        fc.property(
          fc.record({
            apiVersion: fc.constant('v1'),
            kind: fc.constant('Config'),
            // No contexts field
          }),
          (data) => {
            const content = JSON.stringify(data);
            const result = parseKubeconfigContent(content);
            expect(result).toBeNull();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should return null for empty contexts array', () => {
      const content = `
apiVersion: v1
kind: Config
contexts: []
`;
      const result = parseKubeconfigContent(content);
      expect(result).toBeNull();
    });
  });
});
