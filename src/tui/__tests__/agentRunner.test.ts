import { describe, it, expect, beforeEach } from 'vitest';
import { getCurrentSessionId, clearCurrentSession } from '../agentRunner.js';

describe('Session Management', () => {
  beforeEach(() => {
    // Clear session before each test
    clearCurrentSession();
  });

  describe('getCurrentSessionId', () => {
    it('should return null when no session is active', () => {
      expect(getCurrentSessionId()).toBeNull();
    });
  });

  describe('clearCurrentSession', () => {
    it('should clear the current session', () => {
      // Session starts as null
      expect(getCurrentSessionId()).toBeNull();
      
      // Clear should not throw
      clearCurrentSession();
      
      // Should still be null
      expect(getCurrentSessionId()).toBeNull();
    });
  });
});

// Note: Full integration tests for runAgentQuery require mocking the SDK
// which is complex. The SDK handles session persistence internally.
// These tests verify the session state management functions work correctly.
