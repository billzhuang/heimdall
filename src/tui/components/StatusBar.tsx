import React from 'react';
import { Box, Text } from 'ink';

export interface StatusBarProps {
  context: string | null;
  namespace: string;
  model: string;
  hint?: string | null;
  sessionName?: string | null;
}

export function StatusBar({ context, namespace, model, hint, sessionName }: StatusBarProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyan">{context || 'no-context'}</Text>
        <Text color="gray"> │ </Text>
        <Text color="yellow">{namespace}</Text>
        <Text color="gray"> │ </Text>
        <Text color="green">{model}</Text>
        {sessionName && (
          <>
            <Text color="gray"> │ </Text>
            <Text color="magenta">📌 {sessionName}</Text>
          </>
        )}
      </Box>
      {hint && (
        <Text color="yellow" dimColor>⚠ {hint}</Text>
      )}
    </Box>
  );
}
