import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { getCurrentSessionId, clearCurrentSession } from '../agentRunner.js';

/**
 * Property-based tests for agent runner session management
 * 
 * Note: The SDK now handles conversation context internally with persistSession: true.
 * These tests verify the session state management functions.
 */
describe('agentRunner property tests', () => {
  beforeEach(() => {
    clearCurrentSession();
  });

  /**
   * Property: Session state consistency
   * After clearing a session, getCurrentSessionId should always return null.
   */
  describe('Property: Session state consistency', () => {
    it('should always return null after clearCurrentSession', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10 }),
          (clearCount) => {
            // Clear multiple times
            for (let i = 0; i < clearCount; i++) {
              clearCurrentSession();
            }
            
            // Should always be null after clearing
            expect(getCurrentSessionId()).toBeNull();
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  /**
   * Property: Clear operation is idempotent
   * Calling clearCurrentSession multiple times should have the same effect as calling it once.
   */
  describe('Property: Clear operation idempotency', () => {
    it('should be idempotent', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          (times) => {
            // Clear once
            clearCurrentSession();
            const afterOne = getCurrentSessionId();
            
            // Clear many more times
            for (let i = 0; i < times; i++) {
              clearCurrentSession();
            }
            const afterMany = getCurrentSessionId();
            
            // Result should be the same
            expect(afterMany).toBe(afterOne);
            expect(afterMany).toBeNull();
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});
