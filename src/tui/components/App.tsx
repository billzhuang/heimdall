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
import { parseCommand, isSlashCommand, isQuickCheck, isQuery } from '../commandParser.js';
import {
  runQuickCheck,
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

  // Load kubeconfig on mount
  useEffect(() => {
    async function loadContexts() {
      const data = await parseKubeconfig(kubeconfig);
      if (data) {
        actions.setContexts(data.contexts.map(c => c.name), data.currentContext);
      }
    }
    loadContexts();
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
        content: 'No context selected. Use /ctx to select a Kubernetes context.',
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
      onToolUse: (toolName: string, command?: string) => {
        actions.addMessage({
          id: generateMessageId(),
          type: 'tool',
          content: `Running ${toolName}`,
          timestamp: new Date(),
          metadata: { toolName, command },
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
      if (isQuickCheck(cmd)) {
        await runQuickCheck(cmd.mode, options, callbacks, conversationContext);
      } else if (isQuery(cmd)) {
        await runAgentQuery(cmd.text, options, callbacks, conversationContext);
      }
    } catch (error) {
      // Error already handled in callbacks
    }
  }, [state.context, actions, exit, verbose, transcriptPath]);

  // Setup mode - show context selector first
  if (state.mode === 'setup' && state.setupStep === 'context') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">Welcome to Heimdall - Interactive Health Check</Text>
        <Text color="gray">📁 Kubeconfig: {kubeconfig}</Text>
        <Box marginTop={1}>
          {state.contexts.length > 0 ? (
            <ContextSelector
              contexts={state.contexts}
              currentContext={state.currentContext}
              selectedContext={state.context}
              onSelect={actions.setContext}
              onCancel={() => exit()}
            />
          ) : (
            <Text color="yellow">Loading contexts...</Text>
          )}
        </Box>
      </Box>
    );
  }

  // Setup mode - show namespace selector
  if (state.mode === 'setup' && state.setupStep === 'namespace' && state.context) {
    return (
      <Box flexDirection="column" padding={1}>
        <StatusBar context={state.context} namespace={state.namespace} model={state.model} />
        <NamespaceSelector
          context={state.context}
          kubeconfigPath={kubeconfig}
          selectedNamespace={state.namespace}
          onSelect={actions.setNamespace}
          onCancel={() => actions.setSetupStep('context')}
        />
      </Box>
    );
  }

  // Selector mode overlays
  if (state.mode === 'selector') {
    return (
      <Box flexDirection="column" padding={1}>
        <StatusBar context={state.context} namespace={state.namespace} model={state.model} />
        {state.activeSelector === 'context' && (
          <ContextSelector
            contexts={state.contexts}
            currentContext={state.currentContext}
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
      <StatusBar context={state.context} namespace={state.namespace} model={state.model} />
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
  /clear    - Clear conversation history
  /new      - Start new conversation
  /compact  - Compact conversation context
  /help     - Show this help
  /exit     - Exit Heimdall

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
