import React from 'react';
import { Box, Text } from 'ink';

export interface StatusBarProps {
  context: string | null;
  namespace: string;
  model: string;
}

export function StatusBar({ context, namespace, model }: StatusBarProps): React.ReactElement {
  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginBottom={1}
    >
      <Box marginRight={2}>
        <Text color="blue">🔷 Context: </Text>
        <Text color="white" bold>{context || 'not set'}</Text>
      </Box>
      <Box marginRight={2}>
        <Text color="yellow">📁 Namespace: </Text>
        <Text color="white" bold>{namespace}</Text>
      </Box>
      <Box>
        <Text color="green">🤖 Model: </Text>
        <Text color="white" bold>{model}</Text>
      </Box>
    </Box>
  );
}
