import React, { useEffect, useCallback } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { StatusBar } from './StatusBar.js';
import { OutputArea } from './OutputArea.js';
import { InputField } from './InputField.js';
import { ContextSelector } from './ContextSelector.js';
import { NamespaceSelector } from './NamespaceSelector.js';
import { ModelSelector } from './ModelSelector.js';
import { useAppState } from '../useAppState.js';
import { parseKubeconfig } from '../kubeconfigParser.js';
import { parseCommand, isSlashCommand, isQuery } from '../commandParser.js';
import {
  runAgentQuery,
  ConversationContext,
  type OutputMessage,
} from '../agentRunner.js';

export interface AppProps {
  kubeconfig: string;
  verbose?: boolean;
  transcriptPath?: string;
}

// Global conversation context
const conversationContext = new ConversationContext();

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function App({ kubeconfig, verbose, transcriptPath }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [state, actions] = useAppState(kubeconfig);

  // Load kubeconfig on mount and auto-select defaults
  useEffect(() => {
    async function loadDefaults() {
      const data = await parseKubeconfig(kubeconfig);
      if (data) {
        // Store all contexts for later selection
        actions.setContexts(data.contexts.map(c => c.name));
        
        // Auto-select current context from kubeconfig
        if (data.currentContext) {
          actions.setContext(data.currentContext);
          
          // Find the context to get its default namespace
          const ctx = data.contexts.find(c => c.name === data.currentContext);
          if (ctx?.namespace) {
            actions.setNamespace(ctx.namespace);
          } else {
            // No default namespace, use kube-system as safe default
            actions.setNamespace('kube-system');
          }
        } else if (data.contexts.length > 0) {
          // No current-context set, use first available
          actions.setContext(data.contexts[0].name);
          actions.setNamespace('kube-system');
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

  // Handle Ctrl+C
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
    }
  });

  const handleCommand = useCallback(async (input: string) => {
    const cmd = parseCommand(input);

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
        case 'new':
          conversationContext.clear();
          actions.clearMessages();
          actions.addMessage({
            id: generateMessageId(),
            type: 'system',
            content: 'Conversation cleared. Starting fresh.',
            timestamp: new Date(),
          });
          break;
        case 'compact':
          const summary = conversationContext.compact();
          conversationContext.clear();
          if (summary) {
            conversationContext.addTurn('assistant', summary);
          }
          actions.addMessage({
            id: generateMessageId(),
            type: 'system',
            content: 'Conversation compacted.',
            timestamp: new Date(),
          });
          break;
        case 'context':
          showContextStats(actions.addMessage, conversationContext);
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
    const options = { config, model: modelId, verbose, transcriptPath };

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
      onComplete: (cost?: number, duration?: number) => {
        actions.addMessage({
          id: generateMessageId(),
          type: 'info',
          content: 'Complete',
          timestamp: new Date(),
          metadata: { cost, duration },
        });
        actions.setRunning(false);
      },
      onError: (error: Error) => {
        actions.addMessage({
          id: generateMessageId(),
          type: 'error',
          content: error.message,
          timestamp: new Date(),
        });
        actions.setRunning(false);
      },
    };

    actions.setRunning(true);

    try {
      // All queries go through runAgentQuery - LLM decides what to check
      const queryText = cmd.type === 'quickCheck' 
        ? `${cmd.mode === 'all' ? 'comprehensive' : 'quick'} health check`
        : (cmd as { text: string }).text;
      await runAgentQuery(queryText, options, callbacks, conversationContext);
    } catch (error) {
      // Error already handled in callbacks
    }
  }, [state.context, actions, exit, verbose, transcriptPath]);

  // Selector overlays
  if (state.mode === 'selector') {
    return (
      <Box flexDirection="column" padding={1}>
        <StatusBar 
          context={state.context} 
          namespace={state.namespace} 
          model={state.model}
          hint={state.statusHint}
        />
        {state.activeSelector === 'context' && (
          <ContextSelector
            contexts={state.contexts}
            currentContext={state.context}
            selectedContext={state.context}
            onSelect={(ctx) => {
              actions.setContext(ctx);
              actions.closeSelector();
            }}
            onCancel={actions.closeSelector}
          />
        )}
        {state.activeSelector === 'namespace' && state.context && (
          <NamespaceSelector
            context={state.context}
            kubeconfigPath={kubeconfig}
            selectedNamespace={state.namespace}
            onSelect={(ns) => {
              actions.setNamespace(ns);
              actions.closeSelector();
            }}
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
      </Box>
    );
  }

  // Main REPL mode
  return (
    <Box flexDirection="column" padding={1}>
      <StatusBar 
        context={state.context} 
        namespace={state.namespace} 
        model={state.model}
        hint={state.statusHint}
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
  /ctx      - Select Kubernetes context
  /ns       - Select namespace
  /model    - Select LLM model
  /context  - Show conversation memory stats
  /clear    - Clear conversation history
  /new      - Start new conversation
  /compact  - Compact conversation context
  /help     - Show this help
  /exit     - Exit Heimdall
  /quit     - Exit Heimdall

Quick Checks:
  "quick check"         - Run smoke test
  "comprehensive check" - Run full health check

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

function showContextStats(addMessage: (msg: OutputMessage) => void, context: ConversationContext): void {
  const stats = context.getStats();
  
  const formatDate = (date: Date | null) => {
    if (!date) return 'N/A';
    return date.toLocaleTimeString();
  };

  const statsText = `
📊 Conversation Memory Stats
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Session ID:       ${stats.sessionId}
Total Turns:      ${stats.turnCount}
  • User:         ${stats.userTurns}
  • Assistant:    ${stats.assistantTurns}
Total Characters: ${stats.totalChars.toLocaleString()}
Est. Tokens:      ~${stats.estimatedTokens.toLocaleString()}
First Message:    ${formatDate(stats.oldestTurn)}
Last Message:     ${formatDate(stats.newestTurn)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${stats.turnCount === 0 ? '💡 Tip: Start a conversation to build context for follow-up questions.' : '💡 Tip: Use /compact to reduce context size, or /clear to start fresh.'}
`;

  addMessage({
    id: generateMessageId(),
    type: 'system',
    content: statsText,
    timestamp: new Date(),
  });
}
