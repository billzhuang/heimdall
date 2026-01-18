import React, { useEffect, useCallback, useRef, useState } from 'react';
import { Box, useApp, useInput } from 'ink';
import { StatusBar } from './StatusBar.js';
import { OutputArea } from './OutputArea.js';
import { InputField } from './InputField.js';
import { ContextSelector } from './ContextSelector.js';
import { NamespaceSelector } from './NamespaceSelector.js';
import { ModelSelector } from './ModelSelector.js';
import { SessionSelector } from './SessionSelector.js';
import { WelcomeScreen } from './WelcomeScreen.js';
import { useAppState } from '../useAppState.js';
import { parseKubeconfig } from '../kubeconfigParser.js';
import { parseCommand, isSlashCommand } from '../commandParser.js';
import { HEIMDALL_VERSION } from '../constants.js';
import {
  runAgentQuery,
  getCurrentSessionId,
  clearCurrentSession,
  type OutputMessage,
  type AgentController,
} from '../agentRunner.js';
import {
  findSession,
  getMostRecentSessionId,
  readSessionFile,
  saveSessionMetadata,
  readSessionMetadata,
  renameSession,
  type SessionInfo,
} from '../sessionManager.js';

export interface AppProps {
  kubeconfig: string;
  verbose?: boolean;
}

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function App({ kubeconfig, verbose }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [state, actions] = useAppState(kubeconfig);
  const agentControllerRef = useRef<AgentController | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [resumeSessionId, setResumeSessionId] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState<string | null>(null);

  // Load kubeconfig on mount and auto-select defaults (runs only once)
  const hasInitialized = useRef(false);
  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;
    
    async function loadDefaults() {
      const data = await parseKubeconfig(kubeconfig);
      if (data) {
        // Store context data for namespace lookups
        actions.setContextData(data.contexts);
        
        // Store all context names for selector
        actions.setContexts(data.contexts.map(c => c.name));
        
        // Auto-select current context from kubeconfig
        if (data.currentContext) {
          // setContext will handle namespace reset using contextDataRef
          actions.setContext(data.currentContext);
        } else if (data.contexts.length > 0) {
          // No current-context set, use first available
          actions.setContext(data.contexts[0].name);
          actions.setStatusHint('No default context in kubeconfig, using first available');
        } else {
          actions.setStatusHint('No contexts found in kubeconfig');
        }
      } else {
        actions.setStatusHint('Failed to load kubeconfig');
      }
    }
    loadDefaults();
  }, [kubeconfig, actions]);

  // Handle Ctrl+C and ESC
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
    }
    // ESC to cancel running query
    if (key.escape && state.isRunning && agentControllerRef.current) {
      agentControllerRef.current.cancel();
      agentControllerRef.current = null;
      actions.setRunning(false);
    }
  });

  // Handle session selection from SessionSelector
  const handleSessionSelect = useCallback((session: SessionInfo) => {
    setResumeSessionId(session.sessionId);
    // Restore context/namespace and name if available
    if (session.context) {
      actions.setContext(session.context);
      if (session.namespace) {
        actions.setNamespace(session.namespace);
      }
    }
    if (session.name) {
      setSessionName(session.name);
    }
    actions.closeSelector();
    const displayName = session.name || session.firstMessage;
    const ctxInfo = session.context ? ` [${session.context}/${session.namespace || 'default'}]` : '';
    actions.addMessage({
      id: generateMessageId(),
      type: 'system',
      content: `Will resume "${displayName}"${ctxInfo} on next query.`,
      timestamp: new Date(),
    });
  }, [actions]);

  const handleCommand = useCallback(async (input: string) => {
    const cmd = parseCommand(input);

    // Dismiss welcome screen on any interaction
    if (!state.hasInteracted) {
      actions.setHasInteracted(true);
    }

    // Echo user input
    actions.addMessage({
      id: generateMessageId(),
      type: 'user',
      content: input,
      timestamp: new Date(),
    });

    if (isSlashCommand(cmd)) {
      switch (cmd.type) {
        case 'ctx':
          actions.openSelector('context');
          break;
        case 'ns':
          actions.openSelector('namespace');
          break;
        case 'model':
          actions.openSelector('model');
          break;
        case 'help':
          showHelp(actions.addMessage);
          break;
        case 'exit':
          exit();
          break;
        case 'clear':
          actions.clearMessages();
          actions.addMessage({
            id: generateMessageId(),
            type: 'system',
            content: 'Output cleared. Session preserved.',
            timestamp: new Date(),
          });
          break;
        case 'new':
          clearCurrentSession();
          setSessionId(null);
          setResumeSessionId(null);
          setSessionName(null);
          actions.clearMessages();
          actions.addMessage({
            id: generateMessageId(),
            type: 'system',
            content: 'New session started.',
            timestamp: new Date(),
          });
          break;
        case 'continue':
          // Get most recent session and set it for resume
          getMostRecentSessionId().then(async recentId => {
            if (recentId) {
              setResumeSessionId(recentId);
              // Restore context/namespace and name from metadata
              const metadata = await readSessionMetadata(recentId);
              if (metadata) {
                actions.setContext(metadata.context);
                actions.setNamespace(metadata.namespace);
                if (metadata.name) {
                  setSessionName(metadata.name);
                }
              }
              const displayName = metadata?.name || recentId.slice(0, 8) + '...';
              actions.addMessage({
                id: generateMessageId(),
                type: 'system',
                content: metadata?.context 
                  ? `Will resume "${displayName}" [${metadata.context}/${metadata.namespace}] on next query.`
                  : `Will resume "${displayName}" on next query.`,
                timestamp: new Date(),
              });
            } else {
              actions.addMessage({
                id: generateMessageId(),
                type: 'system',
                content: 'No previous sessions found.',
                timestamp: new Date(),
              });
            }
          });
          break;
        case 'sessions':
          // Open session selector (same as /resume without args)
          actions.openSelector('session');
          break;
        case 'resume':
          if (cmd.query) {
            findSession(cmd.query).then(async session => {
              if (session) {
                handleSessionSelect(session);
              } else {
                actions.addMessage({
                  id: generateMessageId(),
                  type: 'error',
                  content: `Session not found: ${cmd.query}. Use /resume to browse sessions.`,
                  timestamp: new Date(),
                });
              }
            });
          } else {
            // Open session selector
            actions.openSelector('session');
          }
          break;
        case 'context':
          showSessionContext(actions.addMessage, sessionId, resumeSessionId, state.context, state.namespace, sessionName);
          break;
        case 'rename':
          if (cmd.name) {
            const targetId = resumeSessionId || sessionId || getCurrentSessionId();
            if (targetId) {
              renameSession(targetId, cmd.name).then(success => {
                if (success) {
                  setSessionName(cmd.name!);
                  actions.addMessage({
                    id: generateMessageId(),
                    type: 'system',
                    content: `Session renamed to "${cmd.name}"`,
                    timestamp: new Date(),
                  });
                } else {
                  actions.addMessage({
                    id: generateMessageId(),
                    type: 'error',
                    content: 'Failed to rename session.',
                    timestamp: new Date(),
                  });
                }
              });
            } else {
              actions.addMessage({
                id: generateMessageId(),
                type: 'error',
                content: 'No active session to rename. Run a query first.',
                timestamp: new Date(),
              });
            }
          } else {
            // Show current name and usage
            const currentName = sessionName ? `Current: "${sessionName}"` : 'No name set';
            actions.addMessage({
              id: generateMessageId(),
              type: 'system',
              content: `${currentName}\nUsage: /rename My Session Name`,
              timestamp: new Date(),
            });
          }
          break;
      }
      return;
    }

    if (cmd.type === 'unknown') {
      actions.addMessage({
        id: generateMessageId(),
        type: 'error',
        content: `Unknown command. Type /help for available commands.`,
        timestamp: new Date(),
      });
      return;
    }

    // Need context to run queries
    if (!state.context) {
      actions.addMessage({
        id: generateMessageId(),
        type: 'error',
        content: 'No context available. Check your kubeconfig at ~/.kube/config',
        timestamp: new Date(),
      });
      return;
    }

    const config = actions.buildConfig();
    if (!config) {
      actions.addMessage({
        id: generateMessageId(),
        type: 'error',
        content: 'Invalid configuration.',
        timestamp: new Date(),
      });
      return;
    }

    const modelId = actions.getModelId();
    const options = { 
      config, 
      model: modelId, 
      verbose,
      resumeSessionId: resumeSessionId || undefined,
    };
    
    // Reset resume session ID after use
    if (resumeSessionId) {
      setResumeSessionId(null);
    }

    const callbacks = {
      onMessage: (msg: OutputMessage) => actions.addMessage(msg),
      onToolUse: (toolName: string, details?: string) => {
        actions.addMessage({
          id: generateMessageId(),
          type: 'tool',
          content: details ? `Running ${toolName}: ${details}` : `Running ${toolName}`,
          timestamp: new Date(),
          metadata: { toolName, command: details },
        });
      },
      onComplete: (cost?: number, duration?: number, newSessionId?: string) => {
        agentControllerRef.current = null;
        const activeSessionId = newSessionId || sessionId;
        if (activeSessionId) {
          setSessionId(activeSessionId);
          // Always update metadata with current ctx/ns on query completion
          if (state.context) {
            saveSessionMetadata(activeSessionId, state.context, state.namespace || 'default');
          }
        }
        actions.addMessage({
          id: generateMessageId(),
          type: 'info',
          content: 'Complete',
          timestamp: new Date(),
          metadata: { cost, duration, sessionId: activeSessionId || undefined },
        });
        actions.setRunning(false);
      },
      onError: (error: Error) => {
        agentControllerRef.current = null;
        actions.addMessage({
          id: generateMessageId(),
          type: 'error',
          content: error.message,
          timestamp: new Date(),
        });
        actions.setRunning(false);
      },
      onSessionId: (id: string) => {
        setSessionId(id);
      },
    };

    actions.setRunning(true);

    try {
      // All queries go directly to the LLM
      const queryText = (cmd as { text: string }).text;
      const controller = await runAgentQuery(queryText, options, callbacks);
      agentControllerRef.current = controller;
    } catch (error) {
      // Error already handled in callbacks
    }
  }, [state.context, state.namespace, state.hasInteracted, actions, exit, verbose, resumeSessionId, sessionId]);

  // Welcome screen - show when user hasn't interacted yet and not in selector mode
  if (!state.hasInteracted && state.mode !== 'selector') {
    return (
      <Box flexDirection="column" padding={1}>
        <WelcomeScreen
          version={HEIMDALL_VERSION}
          context={state.context}
          namespace={state.namespace}
          onSubmit={handleCommand}
          disabled={state.isRunning}
        />
      </Box>
    );
  }

  // Selector overlays
  if (state.mode === 'selector') {
    return (
      <Box flexDirection="column" padding={1}>
        <StatusBar 
          key={`${state.context}-${state.namespace}-${state.model}-${sessionName}`}
          context={state.context} 
          namespace={state.namespace} 
          model={state.model}
          hint={state.statusHint}
          sessionName={sessionName}
        />
        {state.activeSelector === 'context' && (
          <ContextSelector
            contexts={state.contexts}
            currentContext={state.context}
            selectedContext={state.context}
            onSelect={actions.setContext}
            onCancel={actions.closeSelector}
          />
        )}
        {state.activeSelector === 'namespace' && state.context && (
          <NamespaceSelector
            context={state.context}
            kubeconfigPath={kubeconfig}
            selectedNamespace={state.namespace}
            onSelect={actions.setNamespace}
            onCancel={actions.closeSelector}
          />
        )}
        {state.activeSelector === 'model' && (
          <ModelSelector
            selectedModel={state.model}
            onSelect={actions.setModel}
            onCancel={actions.closeSelector}
          />
        )}
        {state.activeSelector === 'session' && (
          <SessionSelector
            onSelect={handleSessionSelect}
            onCancel={actions.closeSelector}
            currentSessionId={resumeSessionId || sessionId}
          />
        )}
      </Box>
    );
  }

  // Main REPL mode
  return (
    <Box flexDirection="column" padding={1}>
      <StatusBar 
        key={`${state.context}-${state.namespace}-${state.model}-${sessionName}`}
        context={state.context} 
        namespace={state.namespace} 
        model={state.model}
        hint={state.statusHint}
        sessionName={sessionName}
      />
      <OutputArea messages={state.messages} />
      <InputField
        onSubmit={handleCommand}
        disabled={state.isRunning}
      />
    </Box>
  );
}

function showHelp(addMessage: (msg: OutputMessage) => void): void {
  const helpText = `
Available Commands:
  /ctx       - Select Kubernetes context
  /ns        - Select namespace
  /model     - Select LLM model
  /context   - Show current session info
  /resume    - Browse and resume saved sessions
  /continue  - Continue most recent session
  /rename X  - Name current session
  /new       - Start new session
  /clear     - Clear output (keeps session)
  /help      - Show this help
  /exit      - Exit Heimdall

General Queries:
  Ask any K8s question like:
  - "show me pods in crashloop"
  - "what's wrong with my deployments"
  - "check ingress configuration"
`;

  addMessage({
    id: generateMessageId(),
    type: 'system',
    content: helpText,
    timestamp: new Date(),
  });
}

async function showSessionContext(
  addMessage: (msg: OutputMessage) => void,
  sessionId: string | null,
  resumeSessionId: string | null,
  currentContext: string | null,
  currentNamespace: string,
  sessionName: string | null
): Promise<void> {
  const targetId = resumeSessionId || sessionId || getCurrentSessionId();
  
  // Build status section
  const lines: string[] = [
    `📊 Session Context`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
  ];
  
  // Current K8s context
  lines.push(`K8s Context:  ${currentContext || '(none)'}`);
  lines.push(`Namespace:    ${currentNamespace}`);
  lines.push('');
  
  // Session status
  if (sessionName) {
    lines.push(`Session:      📌 ${sessionName}`);
  } else if (resumeSessionId) {
    lines.push(`Session:      ${resumeSessionId.slice(0, 12)}... (pending resume)`);
  } else if (targetId) {
    lines.push(`Session:      ${targetId.slice(0, 12)}...`);
  } else {
    lines.push(`Session:      (no active session)`);
  }
  
  // If we have a session, show conversation history
  if (targetId) {
    const content = await readSessionFile(targetId);
    
    if (content) {
      const rawLines = content.trim().split('\n');
      const SKIP_TYPES = ['queue-operation', 'init', 'result'];
      
      // Parse messages
      const messages: Array<{ type: string; text: string }> = [];
      for (const line of rawLines) {
        try {
          const entry = JSON.parse(line);
          const type = entry.type || 'unknown';
          if (SKIP_TYPES.includes(type)) continue;
          
          let text = '';
          if ((type === 'user' || type === 'assistant') && entry.message?.content) {
            const textContent = entry.message.content.find(
              (c: { type: string; text?: string }) => c.type === 'text'
            );
            text = textContent?.text || '';
          } else if (type === 'summary') {
            text = '(conversation summary)';
          } else {
            continue;
          }
          
          if (text) {
            messages.push({ type, text });
          }
        } catch {
          // Skip malformed
        }
      }
      
      lines.push(`Messages:     ${messages.length} turns`);
      lines.push('');
      lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      lines.push('📝 Conversation History');
      lines.push('');
      
      // Show last 5 turns (or all if fewer)
      const recentMessages = messages.slice(-10);
      const skipped = messages.length - recentMessages.length;
      
      if (skipped > 0) {
        lines.push(`   ... ${skipped} earlier messages ...`);
        lines.push('');
      }
      
      for (const msg of recentMessages) {
        const prefix = msg.type === 'user' ? '👤' : '🤖';
        // Show first 120 chars of each message
        const preview = msg.text.replace(/\n/g, ' ').slice(0, 120);
        const truncated = msg.text.length > 120 ? '...' : '';
        lines.push(`${prefix} ${preview}${truncated}`);
      }
    } else {
      lines.push(`Messages:     (unable to read session file)`);
    }
  }
  
  lines.push('');
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push('💡 /sessions to list | /resume N to switch | /new to start fresh');
  
  addMessage({
    id: generateMessageId(),
    type: 'system',
    content: lines.join('\n'),
    timestamp: new Date(),
  });
}
