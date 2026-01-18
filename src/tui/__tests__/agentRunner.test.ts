import { describe, it, expect, beforeEach } from 'vitest';
import { 
  getCurrentSessionId, 
  clearCurrentSession,
  type AgentRunnerOptions,
  type AgentRunnerCallbacks,
  type OutputMessage,
  type SessionInfo,
  type AgentController,
} from '../agentRunner.js';

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

    it('should be idempotent - multiple clears should not throw', () => {
      clearCurrentSession();
      clearCurrentSession();
      clearCurrentSession();
      expect(getCurrentSessionId()).toBeNull();
    });
  });
});

describe('AgentRunnerOptions interface', () => {
  it('should accept valid options with required fields', () => {
    const options: AgentRunnerOptions = {
      config: {
        context: 'test-context',
        namespace: 'default',
        kubeconfig: '/path/to/kubeconfig',
      },
      model: 'claude-sonnet-4-5-20250929',
    };
    
    expect(options.config.context).toBe('test-context');
    expect(options.model).toBe('claude-sonnet-4-5-20250929');
    expect(options.verbose).toBeUndefined();
    expect(options.resumeSessionId).toBeUndefined();
  });

  it('should accept options with resumeSessionId for session continuation', () => {
    const options: AgentRunnerOptions = {
      config: {
        context: 'prod-cluster',
        namespace: 'kube-system',
        kubeconfig: '~/.kube/config',
      },
      model: 'claude-opus-4-5-20251101',
      verbose: true,
      resumeSessionId: 'session-abc123',
    };
    
    expect(options.resumeSessionId).toBe('session-abc123');
    expect(options.verbose).toBe(true);
  });

  it('should handle "all" namespace for cluster-wide queries', () => {
    const options: AgentRunnerOptions = {
      config: {
        context: 'dev-cluster',
        namespace: 'all',
        kubeconfig: '/custom/kubeconfig',
      },
      model: 'claude-haiku-4-5-20251001',
    };
    
    expect(options.config.namespace).toBe('all');
  });
});

describe('AgentRunnerCallbacks interface', () => {
  it('should define all required callback functions', () => {
    const messages: OutputMessage[] = [];
    const toolCalls: Array<{ name: string; details?: string }> = [];
    let completeCalled = false;
    let errorCalled = false;
    let capturedSessionId: string | undefined;

    const callbacks: AgentRunnerCallbacks = {
      onMessage: (msg) => messages.push(msg),
      onToolUse: (name, details) => toolCalls.push({ name, details }),
      onComplete: (cost, duration, sessionId) => {
        completeCalled = true;
        capturedSessionId = sessionId;
      },
      onError: (error) => {
        errorCalled = true;
      },
      onSessionId: (id) => {
        capturedSessionId = id;
      },
    };

    // Test onMessage
    callbacks.onMessage({
      id: 'msg-1',
      type: 'system',
      content: 'Test message',
      timestamp: new Date(),
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Test message');

    // Test onToolUse
    callbacks.onToolUse('Bash', '$ kubectl get pods');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('Bash');
    expect(toolCalls[0].details).toBe('$ kubectl get pods');

    // Test onComplete
    callbacks.onComplete(0.05, 1500, 'session-xyz');
    expect(completeCalled).toBe(true);
    expect(capturedSessionId).toBe('session-xyz');

    // Test onSessionId (optional callback)
    callbacks.onSessionId?.('new-session-id');
    expect(capturedSessionId).toBe('new-session-id');
  });

  it('should allow onSessionId to be optional', () => {
    const callbacks: AgentRunnerCallbacks = {
      onMessage: () => {},
      onToolUse: () => {},
      onComplete: () => {},
      onError: () => {},
      // onSessionId intentionally omitted
    };

    // Should not throw when calling optional callback
    expect(callbacks.onSessionId).toBeUndefined();
  });
});

describe('OutputMessage interface', () => {
  it('should support all message types', () => {
    const types: OutputMessage['type'][] = ['system', 'user', 'assistant', 'tool', 'error', 'info'];
    
    for (const type of types) {
      const msg: OutputMessage = {
        id: `msg-${type}`,
        type,
        content: `Content for ${type}`,
        timestamp: new Date(),
      };
      expect(msg.type).toBe(type);
    }
  });

  it('should support optional metadata', () => {
    const msgWithMetadata: OutputMessage = {
      id: 'msg-with-meta',
      type: 'tool',
      content: 'Running kubectl',
      timestamp: new Date(),
      metadata: {
        toolName: 'Bash',
        command: 'kubectl get pods',
        cost: 0.001,
        duration: 500,
        sessionId: 'session-123',
      },
    };

    expect(msgWithMetadata.metadata?.toolName).toBe('Bash');
    expect(msgWithMetadata.metadata?.cost).toBe(0.001);
    expect(msgWithMetadata.metadata?.sessionId).toBe('session-123');
  });

  it('should work without metadata', () => {
    const msgWithoutMetadata: OutputMessage = {
      id: 'msg-no-meta',
      type: 'assistant',
      content: 'Here are your pods...',
      timestamp: new Date(),
    };

    expect(msgWithoutMetadata.metadata).toBeUndefined();
  });
});

describe('SessionInfo interface', () => {
  it('should have required fields for session display', () => {
    const session: SessionInfo = {
      sessionId: 'abc123def456',
      startTime: new Date('2025-01-15T10:30:00Z'),
      turnCount: 5,
    };

    expect(session.sessionId).toBe('abc123def456');
    expect(session.startTime).toBeInstanceOf(Date);
    expect(session.turnCount).toBe(5);
  });

  it('should handle zero turn count for new sessions', () => {
    const newSession: SessionInfo = {
      sessionId: 'new-session',
      startTime: new Date(),
      turnCount: 0,
    };

    expect(newSession.turnCount).toBe(0);
  });
});

describe('AgentController interface', () => {
  it('should have cancel method', () => {
    let cancelCalled = false;
    
    const controller: AgentController = {
      cancel: () => {
        cancelCalled = true;
      },
    };

    controller.cancel();
    expect(cancelCalled).toBe(true);
  });
});

// Note: Full integration tests for runAgentQuery require mocking the SDK
// which is complex. The SDK handles session persistence internally.
// These tests verify the interfaces and session state management functions work correctly.
