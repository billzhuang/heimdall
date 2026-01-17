import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { ConversationContext } from '../agentRunner.js';

/**
 * Property-based tests for agent runner conversation context
 */
describe('agentRunner property tests', () => {
  /**
   * Property 10: Conversation History Preservation
   * For any sequence of user queries and assistant responses, the conversation
   * history SHALL contain all turns in chronological order.
   * 
   * **Validates: Requirements 8.1, 8.2**
   */
  describe('Property 10: Conversation history preservation', () => {
    // Arbitrary for generating conversation content
    const contentArb = fc.string({ minLength: 1, maxLength: 500 });
    const roleArb = fc.constantFrom<'user' | 'assistant'>('user', 'assistant');

    it('should preserve all turns in order', () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(roleArb, contentArb), { minLength: 1, maxLength: 20 }),
          (turns) => {
            const context = new ConversationContext();
            
            // Add all turns
            for (const [role, content] of turns) {
              context.addTurn(role, content);
            }
            
            // Verify all turns are preserved
            const history = context.getTurns();
            expect(history.length).toBe(turns.length);
            
            // Verify order and content
            for (let i = 0; i < turns.length; i++) {
              expect(history[i].role).toBe(turns[i][0]);
              expect(history[i].content).toBe(turns[i][1]);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should maintain chronological order of timestamps', () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(roleArb, contentArb), { minLength: 2, maxLength: 10 }),
          (turns) => {
            const context = new ConversationContext();
            
            for (const [role, content] of turns) {
              context.addTurn(role, content);
            }
            
            const history = context.getTurns();
            
            // Verify timestamps are in order
            for (let i = 1; i < history.length; i++) {
              expect(history[i].timestamp.getTime()).toBeGreaterThanOrEqual(
                history[i - 1].timestamp.getTime()
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should generate unique IDs for each turn', () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(roleArb, contentArb), { minLength: 2, maxLength: 20 }),
          (turns) => {
            const context = new ConversationContext();
            
            for (const [role, content] of turns) {
              context.addTurn(role, content);
            }
            
            const history = context.getTurns();
            const ids = history.map(t => t.id);
            const uniqueIds = new Set(ids);
            
            expect(uniqueIds.size).toBe(ids.length);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should clear all turns when clear() is called', () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(roleArb, contentArb), { minLength: 1, maxLength: 10 }),
          (turns) => {
            const context = new ConversationContext();
            
            for (const [role, content] of turns) {
              context.addTurn(role, content);
            }
            
            expect(context.isEmpty()).toBe(false);
            
            context.clear();
            
            expect(context.isEmpty()).toBe(true);
            expect(context.getTurns().length).toBe(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should generate new session ID after clear()', () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(roleArb, contentArb), { minLength: 1, maxLength: 5 }),
          (turns) => {
            const context = new ConversationContext();
            const originalSessionId = context.getSessionId();
            
            for (const [role, content] of turns) {
              context.addTurn(role, content);
            }
            
            context.clear();
            const newSessionId = context.getSessionId();
            
            expect(newSessionId).not.toBe(originalSessionId);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should include all turns in getHistory() output', () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(roleArb, contentArb), { minLength: 1, maxLength: 10 }),
          (turns) => {
            const context = new ConversationContext();
            
            for (const [role, content] of turns) {
              context.addTurn(role, content);
            }
            
            const history = context.getHistory();
            
            // Each turn's content should appear in the history string
            for (const [, content] of turns) {
              expect(history).toContain(content);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
