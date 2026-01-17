import React from 'react';
import { Box, Text, Static } from 'ink';
import type { OutputMessage } from '../agentRunner.js';

export interface OutputAreaProps {
  messages: OutputMessage[];
  maxHeight?: number;
}

function getMessageColor(type: OutputMessage['type']): string {
  switch (type) {
    case 'system': return 'cyan';
    case 'user': return 'green';
    case 'assistant': return 'white';
    case 'tool': return 'yellow';
    case 'error': return 'red';
    case 'info': return 'gray';
    default: return 'white';
  }
}

function getMessagePrefix(type: OutputMessage['type']): string {
  switch (type) {
    case 'system': return '⚙️ ';
    case 'user': return '👤 ';
    case 'assistant': return '🤖 ';
    case 'tool': return '🔧 ';
    case 'error': return '❌ ';
    case 'info': return 'ℹ️ ';
    default: return '';
  }
}

function MessageItem({ message }: { message: OutputMessage }): React.ReactElement {
  const color = getMessageColor(message.type);
  const prefix = getMessagePrefix(message.type);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={color}>
          {prefix}
          {message.type === 'tool' && message.metadata?.toolName && (
            <Text bold>[{message.metadata.toolName}] </Text>
          )}
          {message.content}
        </Text>
      </Box>
      {message.type === 'tool' && message.metadata?.command && (
        <Box marginLeft={3}>
          <Text color="gray">$ {message.metadata.command}</Text>
        </Box>
      )}
      {message.metadata?.cost !== undefined && (
        <Box marginLeft={3}>
          <Text color="gray">
            Cost: ${message.metadata.cost.toFixed(4)}
            {message.metadata.duration && ` • Duration: ${(message.metadata.duration / 1000).toFixed(1)}s`}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function OutputArea({ messages }: OutputAreaProps): React.ReactElement {
  if (messages.length === 0) {
    return (
      <Box marginY={1}>
        <Text color="gray">No messages yet. Type a command or question to get started.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={1}>
      <Static items={messages}>
        {(message) => (
          <MessageItem key={message.id} message={message} />
        )}
      </Static>
    </Box>
  );
}
