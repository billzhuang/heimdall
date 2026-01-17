import { describe, it, expect } from 'vitest';
import { ConversationContext } from '../agentRunner.js';

describe('ConversationContext', () => {
  describe('constructor', () => {
    it('should create empty context with session ID', () => {
      const context = new ConversationContext();
      expect(context.isEmpty()).toBe(true);
      expect(context.getSessionId()).toBeTruthy();
    });
  });

  describe('addTurn', () => {
    it('should add user turn', () => {
      const context = new ConversationContext();
      const turn = context.addTurn('user', 'Hello');
      
      expect(turn.role).toBe('user');
      expect(turn.content).toBe('Hello');
      expect(turn.id).toBeTruthy();
      expect(turn.timestamp).toBeInstanceOf(Date);
    });

    it('should add assistant turn', () => {
      const context = new ConversationContext();
      const turn = context.addTurn('assistant', 'Hi there');
      
      expect(turn.role).toBe('assistant');
      expect(turn.content).toBe('Hi there');
    });

    it('should preserve turn order', () => {
      const context = new ConversationContext();
      context.addTurn('user', 'First');
      context.addTurn('assistant', 'Second');
      context.addTurn('user', 'Third');
      
      const turns = context.getTurns();
      expect(turns[0].content).toBe('First');
      expect(turns[1].content).toBe('Second');
      expect(turns[2].content).toBe('Third');
    });
  });

  describe('getTurns', () => {
    it('should return copy of turns array', () => {
      const context = new ConversationContext();
      context.addTurn('user', 'Test');
      
      const turns1 = context.getTurns();
      const turns2 = context.getTurns();
      
      expect(turns1).not.toBe(turns2);
      expect(turns1).toEqual(turns2);
    });
  });

  describe('getHistory', () => {
    it('should format history as string', () => {
      const context = new ConversationContext();
      context.addTurn('user', 'Hello');
      context.addTurn('assistant', 'Hi');
      
      const history = context.getHistory();
      expect(history).toContain('User: Hello');
      expect(history).toContain('Assistant: Hi');
    });

    it('should return empty string for empty context', () => {
      const context = new ConversationContext();
      expect(context.getHistory()).toBe('');
    });
  });

  describe('clear', () => {
    it('should remove all turns', () => {
      const context = new ConversationContext();
      context.addTurn('user', 'Test');
      context.addTurn('assistant', 'Response');
      
      context.clear();
      
      expect(context.isEmpty()).toBe(true);
      expect(context.getTurns()).toHaveLength(0);
    });

    it('should generate new session ID', () => {
      const context = new ConversationContext();
      const oldId = context.getSessionId();
      
      context.clear();
      
      expect(context.getSessionId()).not.toBe(oldId);
    });
  });

  describe('isEmpty', () => {
    it('should return true for new context', () => {
      const context = new ConversationContext();
      expect(context.isEmpty()).toBe(true);
    });

    it('should return false after adding turn', () => {
      const context = new ConversationContext();
      context.addTurn('user', 'Test');
      expect(context.isEmpty()).toBe(false);
    });
  });

  describe('compact', () => {
    it('should return empty string for empty context', () => {
      const context = new ConversationContext();
      expect(context.compact()).toBe('');
    });

    it('should return summary for non-empty context', () => {
      const context = new ConversationContext();
      context.addTurn('user', 'Question 1');
      context.addTurn('assistant', 'Answer 1');
      
      const summary = context.compact();
      expect(summary).toContain('Previous conversation summary');
    });

    it('should include recent turns in summary', () => {
      const context = new ConversationContext();
      context.addTurn('user', 'Recent question');
      context.addTurn('assistant', 'Recent answer');
      
      const summary = context.compact();
      expect(summary).toContain('Recent question');
      expect(summary).toContain('Recent answer');
    });
  });

  describe('getStats', () => {
    it('should return correct stats for empty context', () => {
      const context = new ConversationContext();
      const stats = context.getStats();
      
      expect(stats.turnCount).toBe(0);
      expect(stats.userTurns).toBe(0);
      expect(stats.assistantTurns).toBe(0);
      expect(stats.totalChars).toBe(0);
      expect(stats.oldestTurn).toBeNull();
      expect(stats.newestTurn).toBeNull();
    });

    it('should return correct stats for populated context', () => {
      const context = new ConversationContext();
      context.addTurn('user', 'Hello');
      context.addTurn('assistant', 'Hi there');
      context.addTurn('user', 'How are you?');
      
      const stats = context.getStats();
      
      expect(stats.turnCount).toBe(3);
      expect(stats.userTurns).toBe(2);
      expect(stats.assistantTurns).toBe(1);
      expect(stats.totalChars).toBe('Hello'.length + 'Hi there'.length + 'How are you?'.length);
      expect(stats.oldestTurn).toBeInstanceOf(Date);
      expect(stats.newestTurn).toBeInstanceOf(Date);
    });

    it('should estimate tokens', () => {
      const context = new ConversationContext();
      context.addTurn('user', 'This is a test message');
      
      const stats = context.getStats();
      expect(stats.estimatedTokens).toBeGreaterThan(0);
    });
  });
});
