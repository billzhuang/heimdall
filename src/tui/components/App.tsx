import React, { useEffect, useCallback, useRef } from 'react';
import { Box, useApp, useInput } from 'ink';
import { StatusBar } from './StatusBar.js';
import { OutputArea } from './OutputArea.js';
import { InputField } from './InputField.js';
import { ContextSelector } from './ContextSelector.js';
import { NamespaceSelector } from './NamespaceSelector.js';
import { ModelSelector } from './ModelSelector.js';
import { WelcomeScreen } from './WelcomeScreen.js';
import { useAppState } from '../useAppState.js';
import { parseKubeconfig } from '../kubeconfigParser.js';
import { parseCommand, isSlashCommand } from '../commandParser.js';
import { HEIMDALL_VERSION } from '../constants.js';
import {
  runAgentQuery,
  ConversationContext,
  type OutputMessage,
  type AgentController,
} from '../agentRunner.js';

export interface AppProps {
  kubeconfig: string;
  verbose?: boolean;
}

// Global conversation context
const conversationContext = new ConversationContext();

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function App({ kubeconfig, verbose }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [state, actions] = useAppState(kubeconfig);
  const agentControllerRef = useRef<AgentController | null>(null);

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
          showContextStats(
            actions.addMessage, 
            conversationContext, 
            cmd.subcommand, 
            { context: state.context || 'N/A', namespace: state.namespace }
          );
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
    const options = { config, model: modelId, verbose };

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
        agentControllerRef.current = null;
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
        agentControllerRef.current = null;
        actions.addMessage({
          id: generateMessageId(),
          type: 'error',
          content: error.message,
          timestamp: new Date(),
        });
        actions.setRunning(false);
      },
    };

    // Dismiss welcome screen on first query (transition to REPL mode)
    if (!state.hasInteracted) {
      actions.setHasInteracted(true);
    }

    actions.setRunning(true);

    try {
      // All queries go directly to the LLM
      const queryText = (cmd as { text: string }).text;
      const controller = await runAgentQuery(queryText, options, callbacks, conversationContext);
      agentControllerRef.current = controller;
    } catch (error) {
      // Error already handled in callbacks
    }
  }, [state.context, state.hasInteracted, actions, exit, verbose]);

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
          key={`${state.context}-${state.namespace}-${state.model}`}
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
      </Box>
    );
  }

  // Main REPL mode
  return (
    <Box flexDirection="column" padding={1}>
      <StatusBar 
        key={`${state.context}-${state.namespace}-${state.model}`}
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

function showContextStats(
  addMessage: (msg: OutputMessage) => void, 
  context: ConversationContext,
  subcommand?: 'full' | 'raw',
  config?: { context: string; namespace: string }
): void {
  const stats = context.getStats();
  
  const formatDate = (date: Date | null) => {
    if (!date) return 'N/A';
    return date.toLocaleTimeString();
  };

  // Handle /context full - show all turns
  if (subcommand === 'full') {
    const turnsText = `
📜 Full Conversation History
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${context.getFullTurns()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
    addMessage({
      id: generateMessageId(),
      type: 'system',
      content: turnsText,
      timestamp: new Date(),
    });
    return;
  }

  // Handle /context raw - show what gets sent to Claude
  if (subcommand === 'raw') {
    const history = context.getHistory();
    const namespaceScope = config?.namespace === 'all' 
      ? 'all namespaces' 
      : `namespace: ${config?.namespace || 'default'}`;
    
    const rawText = `
🔧 Raw Context (what gets sent to Claude)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 System Prompt Summary:
  • Context: ${config?.context || 'N/A'}
  • Namespace: ${namespaceScope}
  • Mode: READ-ONLY
  • Tools: Bash, WebSearch, WebFetch

📝 Conversation History (${stats.turnCount} turns, ~${stats.estimatedTokens} tokens):
${history || '(empty)'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 This history is prepended to each new query for context continuity.
`;
    addMessage({
      id: generateMessageId(),
      type: 'system',
      content: rawText,
      timestamp: new Date(),
    });
    return;
  }

  // Default: show stats
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
${stats.turnCount === 0 ? '💡 Tip: Start a conversation to build context for follow-up questions.' : '💡 Tip: Use /context full to see turns, /context raw to see prompt.'}
`;

  addMessage({
    id: generateMessageId(),
    type: 'system',
    content: statsText,
    timestamp: new Date(),
  });
}
