import React from 'react';
import { Box, Text } from 'ink';

export interface StatusBarProps {
  context: string | null;
  namespace: string;
  model: string;
  hint?: string | null;
}

export function StatusBar({ context, namespace, model, hint }: StatusBarProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyan">{context || 'no-context'}</Text>
        <Text color="gray"> │ </Text>
        <Text color="yellow">{namespace}</Text>
        <Text color="gray"> │ </Text>
        <Text color="green">{model}</Text>
      </Box>
      {hint && (
        <Text color="yellow" dimColor>⚠ {hint}</Text>
      )}
    </Box>
  );
}
