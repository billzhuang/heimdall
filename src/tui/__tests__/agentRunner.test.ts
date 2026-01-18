/**
 * Unit tests for agentRunner module
 * - Session management
 * - Interface contracts
 * - Safety hooks (command validation, PreToolUse hook)
 * - maxTurns configuration
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getCurrentSessionId,
  clearCurrentSession,
  type AgentRunnerOptions,
  type AgentRunnerCallbacks,
  type OutputMessage,
  type SessionInfo,
  type AgentController,
} from '../agentRunner.js';
import {
  parseKubectlCommand,
  isDestructiveCommand,
  validateCommand,
  createPreToolUseHook,
  createPreCompactHook,
  DESTRUCTIVE_KUBECTL_COMMANDS,
  ALLOWED_KUBECTL_COMMANDS,
  DEFAULT_MAX_TURNS,
} from '../safetyHooks.js';

// =============================================================================
// Session Management Tests
// =============================================================================

describe('Session Management', () => {
  beforeEach(() => {
    clearCurrentSession();
  });

  describe('getCurrentSessionId', () => {
    it('should return null when no session is active', () => {
      expect(getCurrentSessionId()).toBeNull();
    });
  });

  describe('clearCurrentSession', () => {
    it('should clear the current session', () => {
      expect(getCurrentSessionId()).toBeNull();
      clearCurrentSession();
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

// =============================================================================
// Interface Contract Tests
// =============================================================================

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
    let capturedSessionId: string | undefined;

    const callbacks: AgentRunnerCallbacks = {
      onMessage: (msg) => messages.push(msg),
      onToolUse: (name, details) => toolCalls.push({ name, details }),
      onComplete: (_cost, _duration, sessionId) => {
        completeCalled = true;
        capturedSessionId = sessionId;
      },
      onError: (_error) => {},
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
    };

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

// =============================================================================
// Safety Hooks Tests - Command Parsing
// =============================================================================

describe('parseKubectlCommand', () => {
  it('should parse simple kubectl get command', () => {
    const result = parseKubectlCommand('kubectl get pods');
    expect(result.isKubectl).toBe(true);
    expect(result.subcommand).toBe('get');
    expect(result.args).toEqual(['pods']);
  });

  it('should parse kubectl with context flag', () => {
    const result = parseKubectlCommand('kubectl --context=prod get pods');
    expect(result.isKubectl).toBe(true);
    expect(result.subcommand).toBe('get');
    expect(result.args).toEqual(['pods']);
  });

  it('should parse kubectl with namespace flag', () => {
    const result = parseKubectlCommand('kubectl -n kube-system get pods');
    expect(result.isKubectl).toBe(true);
    expect(result.subcommand).toBe('get');
    expect(result.args).toEqual(['pods']);
  });

  it('should parse complex kubectl command', () => {
    const result = parseKubectlCommand('kubectl --context=prod -n default get pods -o json');
    expect(result.isKubectl).toBe(true);
    expect(result.subcommand).toBe('get');
    expect(result.args).toEqual(['pods', '-o', 'json']);
  });

  it('should return isKubectl=false for non-kubectl commands', () => {
    const result = parseKubectlCommand('ls -la');
    expect(result.isKubectl).toBe(false);
    expect(result.subcommand).toBeNull();
  });

  it('should handle empty string', () => {
    const result = parseKubectlCommand('');
    expect(result.isKubectl).toBe(false);
    expect(result.subcommand).toBeNull();
  });

  it('should handle whitespace only', () => {
    const result = parseKubectlCommand('   ');
    expect(result.isKubectl).toBe(false);
    expect(result.subcommand).toBeNull();
  });

  it('should handle kubectl without subcommand', () => {
    const result = parseKubectlCommand('kubectl');
    expect(result.isKubectl).toBe(true);
    expect(result.subcommand).toBeNull();
  });

  it('should handle kubectl with only options', () => {
    const result = parseKubectlCommand('kubectl --help');
    expect(result.isKubectl).toBe(true);
    expect(result.subcommand).toBeNull();
  });

  // Security: Test for bypass vulnerability with global options that take values
  describe('global options bypass prevention', () => {
    it('should correctly parse kubectl --v 5 delete pods (verbosity bypass attempt)', () => {
      const result = parseKubectlCommand('kubectl --v 5 delete pods');
      expect(result.isKubectl).toBe(true);
      expect(result.subcommand).toBe('delete');
      expect(result.args).toEqual(['pods']);
    });

    it('should correctly parse kubectl -v 5 delete pods (short verbosity bypass attempt)', () => {
      const result = parseKubectlCommand('kubectl -v 5 delete pods');
      expect(result.isKubectl).toBe(true);
      expect(result.subcommand).toBe('delete');
      expect(result.args).toEqual(['pods']);
    });

    it('should correctly parse kubectl --context prod delete pod (space-separated context)', () => {
      const result = parseKubectlCommand('kubectl --context prod delete pod');
      expect(result.isKubectl).toBe(true);
      expect(result.subcommand).toBe('delete');
      expect(result.args).toEqual(['pod']);
    });

    it('should correctly parse kubectl --as admin delete pods (impersonation bypass attempt)', () => {
      const result = parseKubectlCommand('kubectl --as admin delete pods');
      expect(result.isKubectl).toBe(true);
      expect(result.subcommand).toBe('delete');
      expect(result.args).toEqual(['pods']);
    });

    it('should correctly parse kubectl --token abc123 delete pods (token bypass attempt)', () => {
      const result = parseKubectlCommand('kubectl --token abc123 delete pods');
      expect(result.isKubectl).toBe(true);
      expect(result.subcommand).toBe('delete');
      expect(result.args).toEqual(['pods']);
    });

    it('should correctly parse kubectl --server https://k8s.io delete pods (server bypass attempt)', () => {
      const result = parseKubectlCommand('kubectl --server https://k8s.io delete pods');
      expect(result.isKubectl).toBe(true);
      expect(result.subcommand).toBe('delete');
      expect(result.args).toEqual(['pods']);
    });

    it('should correctly parse kubectl -s https://k8s.io delete pods (short server bypass attempt)', () => {
      const result = parseKubectlCommand('kubectl -s https://k8s.io delete pods');
      expect(result.isKubectl).toBe(true);
      expect(result.subcommand).toBe('delete');
      expect(result.args).toEqual(['pods']);
    });
  });
});

// =============================================================================
// Safety Hooks Tests - Destructive Command Detection
// =============================================================================

describe('isDestructiveCommand', () => {
  describe('destructive commands', () => {
    it.each([
      'kubectl apply -f deployment.yaml',
      'kubectl delete pod my-pod',
      'kubectl patch deployment my-deploy',
      'kubectl create namespace test',
      'kubectl scale deployment my-deploy --replicas=3',
      'kubectl drain node-1',
      'kubectl cordon node-1',
      'kubectl taint nodes node-1 key=value:NoSchedule',
      'kubectl edit deployment my-deploy',
      'kubectl replace -f deployment.yaml',
      'kubectl rollout restart deployment my-deploy',
      // Commands that can execute arbitrary code or exfiltrate data
      'kubectl exec -it my-pod -- /bin/bash',
      'kubectl port-forward svc/my-service 8080:80',
      'kubectl attach my-pod -c my-container',
      'kubectl cp my-pod:/path/to/file /local/path',
      'kubectl debug my-pod --image=busybox',
    ])('should detect "%s" as destructive', (command) => {
      expect(isDestructiveCommand(command)).toBe(true);
    });
  });

  describe('destructive commands with global option bypass attempts', () => {
    it.each([
      'kubectl --v 5 delete pods',
      'kubectl -v 5 delete pods',
      'kubectl --as admin delete pods',
      'kubectl --token abc123 delete pods',
      'kubectl --server https://k8s.io delete pods',
      'kubectl -s https://k8s.io apply -f test.yaml',
      'kubectl --kubeconfig /tmp/config delete namespace test',
      'kubectl --user admin --cluster prod delete pods',
    ])('should detect "%s" as destructive (bypass attempt)', (command) => {
      expect(isDestructiveCommand(command)).toBe(true);
    });
  });

  describe('allowed commands', () => {
    it.each([
      'kubectl get pods',
      'kubectl describe pod my-pod',
      'kubectl logs my-pod',
      'kubectl top pods',
      'kubectl explain deployment',
      'kubectl api-resources',
      'kubectl version',
    ])('should detect "%s" as NOT destructive', (command) => {
      expect(isDestructiveCommand(command)).toBe(false);
    });
  });

  describe('non-kubectl commands', () => {
    it.each([
      'ls -la',
      'cat /etc/hosts',
      'echo hello',
      'grep pattern file.txt',
    ])('should detect "%s" as NOT destructive', (command) => {
      expect(isDestructiveCommand(command)).toBe(false);
    });
  });
});

// =============================================================================
// Safety Hooks Tests - Command Validation
// =============================================================================

describe('validateCommand', () => {
  describe('destructive commands', () => {
    it('should block kubectl apply', () => {
      const result = validateCommand('kubectl apply -f deployment.yaml');
      expect(result.allowed).toBe(false);
      expect(result.subcommand).toBe('apply');
      expect(result.reason).toContain('Destructive command');
      expect(result.reason).toContain('Run manually');
    });

    it('should block kubectl delete', () => {
      const result = validateCommand('kubectl delete pod my-pod');
      expect(result.allowed).toBe(false);
      expect(result.subcommand).toBe('delete');
    });
  });

  describe('allowed commands', () => {
    it('should allow kubectl get', () => {
      const result = validateCommand('kubectl get pods');
      expect(result.allowed).toBe(true);
      expect(result.subcommand).toBe('get');
      expect(result.reason).toContain('Read-only');
    });

    it('should allow kubectl describe', () => {
      const result = validateCommand('kubectl describe pod my-pod');
      expect(result.allowed).toBe(true);
      expect(result.subcommand).toBe('describe');
    });
  });

  describe('non-kubectl commands', () => {
    it('should allow ls', () => {
      const result = validateCommand('ls -la');
      expect(result.allowed).toBe(true);
      expect(result.subcommand).toBeNull();
      expect(result.reason).toContain('Not a kubectl command');
    });

    it('should allow cat', () => {
      const result = validateCommand('cat /etc/hosts');
      expect(result.allowed).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should allow empty string', () => {
      const result = validateCommand('');
      expect(result.allowed).toBe(true);
    });

    it('should allow kubectl without subcommand', () => {
      const result = validateCommand('kubectl');
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('without subcommand');
    });

    it('should block unknown kubectl subcommand (default-deny)', () => {
      const result = validateCommand('kubectl unknown-command');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Unknown kubectl subcommand');
    });

    it('should block kubectl proxy (not in allowlist)', () => {
      const result = validateCommand('kubectl proxy');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Unknown kubectl subcommand');
    });
  });
});

// =============================================================================
// Safety Hooks Tests - PreToolUse Hook
// =============================================================================

describe('createPreToolUseHook', () => {
  const mockSignal = new AbortController().signal;

  it('should allow non-Bash tools', async () => {
    const hook = createPreToolUseHook();
    const result = await hook(
      { tool_name: 'Read', tool_input: { path: '/some/file' } },
      undefined,
      { signal: mockSignal }
    );
    expect(result.continue).toBe(true);
    expect(result.permissionDecision).toBeUndefined();
  });

  it('should allow read-only kubectl commands', async () => {
    const hook = createPreToolUseHook();
    const result = await hook(
      { tool_name: 'Bash', tool_input: { command: 'kubectl get pods' } },
      undefined,
      { signal: mockSignal }
    );
    expect(result.continue).toBe(true);
    expect(result.permissionDecision).toBeUndefined();
  });

  it('should block destructive kubectl commands', async () => {
    const hook = createPreToolUseHook();
    const result = await hook(
      { tool_name: 'Bash', tool_input: { command: 'kubectl delete pod my-pod' } },
      undefined,
      { signal: mockSignal }
    );
    expect(result.permissionDecision).toBe('deny');
    expect(result.permissionDecisionReason).toContain('Destructive command');
  });

  it('should call onBlocked callback when command is blocked', async () => {
    const onBlocked = vi.fn();
    const hook = createPreToolUseHook(onBlocked);

    await hook(
      { tool_name: 'Bash', tool_input: { command: 'kubectl apply -f test.yaml' } },
      undefined,
      { signal: mockSignal }
    );

    expect(onBlocked).toHaveBeenCalledWith(
      'kubectl apply -f test.yaml',
      expect.stringContaining('Destructive command'),
      'kubectl apply -f test.yaml'
    );
  });

  it('should not call onBlocked for allowed commands', async () => {
    const onBlocked = vi.fn();
    const hook = createPreToolUseHook(onBlocked);

    await hook(
      { tool_name: 'Bash', tool_input: { command: 'kubectl get pods' } },
      undefined,
      { signal: mockSignal }
    );

    expect(onBlocked).not.toHaveBeenCalled();
  });

  it('should handle missing command in tool_input', async () => {
    const hook = createPreToolUseHook();
    const result = await hook(
      { tool_name: 'Bash', tool_input: {} },
      undefined,
      { signal: mockSignal }
    );
    expect(result.continue).toBe(true);
  });
});

// =============================================================================
// Safety Hooks Tests - PreCompact Hook
// =============================================================================

describe('createPreCompactHook', () => {
  const mockSignal = new AbortController().signal;

  it('should call onCompaction callback with trigger type', async () => {
    const onCompaction = vi.fn();
    const hook = createPreCompactHook(onCompaction);

    await hook(
      {
        hook_event_name: 'PreCompact',
        trigger: 'auto',
        custom_instructions: null,
        session_id: 'test-session',
        transcript_path: '/tmp/transcript',
        cwd: '/tmp',
      },
      undefined,
      { signal: mockSignal }
    );

    expect(onCompaction).toHaveBeenCalledWith('auto', '');
  });

  it('should handle manual trigger', async () => {
    const onCompaction = vi.fn();
    const hook = createPreCompactHook(onCompaction);

    await hook(
      {
        hook_event_name: 'PreCompact',
        trigger: 'manual',
        custom_instructions: 'preserve kubectl output',
        session_id: 'test-session',
        transcript_path: '/tmp/transcript',
        cwd: '/tmp',
      },
      undefined,
      { signal: mockSignal }
    );

    expect(onCompaction).toHaveBeenCalledWith('manual', 'preserve kubectl output');
  });

  it('should return continue: true to allow compaction', async () => {
    const hook = createPreCompactHook();

    const result = await hook(
      {
        hook_event_name: 'PreCompact',
        trigger: 'auto',
        custom_instructions: null,
        session_id: 'test-session',
        transcript_path: '/tmp/transcript',
        cwd: '/tmp',
      },
      undefined,
      { signal: mockSignal }
    );

    expect(result.continue).toBe(true);
  });
});

// =============================================================================
// Safety Hooks Tests - Constants
// =============================================================================

describe('Safety hook constants', () => {
  it('should have all expected destructive commands', () => {
    expect(DESTRUCTIVE_KUBECTL_COMMANDS).toContain('apply');
    expect(DESTRUCTIVE_KUBECTL_COMMANDS).toContain('delete');
    expect(DESTRUCTIVE_KUBECTL_COMMANDS).toContain('patch');
    expect(DESTRUCTIVE_KUBECTL_COMMANDS).toContain('create');
    expect(DESTRUCTIVE_KUBECTL_COMMANDS).toContain('scale');
    expect(DESTRUCTIVE_KUBECTL_COMMANDS).toContain('drain');
    expect(DESTRUCTIVE_KUBECTL_COMMANDS).toContain('cordon');
    expect(DESTRUCTIVE_KUBECTL_COMMANDS).toContain('taint');
    // Commands that can execute arbitrary code or exfiltrate data
    expect(DESTRUCTIVE_KUBECTL_COMMANDS).toContain('exec');
    expect(DESTRUCTIVE_KUBECTL_COMMANDS).toContain('port-forward');
    expect(DESTRUCTIVE_KUBECTL_COMMANDS).toContain('attach');
    expect(DESTRUCTIVE_KUBECTL_COMMANDS).toContain('cp');
  });

  it('should have all expected allowed commands', () => {
    expect(ALLOWED_KUBECTL_COMMANDS).toContain('get');
    expect(ALLOWED_KUBECTL_COMMANDS).toContain('describe');
    expect(ALLOWED_KUBECTL_COMMANDS).toContain('logs');
    expect(ALLOWED_KUBECTL_COMMANDS).toContain('top');
    expect(ALLOWED_KUBECTL_COMMANDS).toContain('explain');
  });
});

// =============================================================================
// MaxTurns Configuration Tests
// =============================================================================

describe('DEFAULT_MAX_TURNS', () => {
  it('should have default value of 15', () => {
    expect(DEFAULT_MAX_TURNS).toBe(15);
  });
});

describe('maxTurns configuration logic', () => {
  /**
   * Helper to simulate the maxTurns configuration logic from agentRunner
   */
  function getEffectiveMaxTurns(maxTurns: number | undefined): number | undefined {
    const effective = maxTurns ?? DEFAULT_MAX_TURNS;
    return effective > 0 ? effective : undefined;
  }

  it('should use default value when maxTurns is undefined', () => {
    const result = getEffectiveMaxTurns(undefined);
    expect(result).toBe(DEFAULT_MAX_TURNS);
  });

  it('should use custom positive value', () => {
    expect(getEffectiveMaxTurns(10)).toBe(10);
    expect(getEffectiveMaxTurns(20)).toBe(20);
    expect(getEffectiveMaxTurns(1)).toBe(1);
  });

  it('should treat zero as unlimited', () => {
    const result = getEffectiveMaxTurns(0);
    expect(result).toBeUndefined();
  });

  it('should treat negative values as unlimited', () => {
    expect(getEffectiveMaxTurns(-1)).toBeUndefined();
    expect(getEffectiveMaxTurns(-100)).toBeUndefined();
  });
});
