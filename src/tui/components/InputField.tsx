import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

export interface InputFieldProps {
  onSubmit: (input: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function InputField({
  onSubmit,
  disabled = false,
  placeholder = 'Type a command or question...',
}: InputFieldProps): React.ReactElement {
  const [value, setValue] = useState('');

  const handleSubmit = (input: string) => {
    if (input.trim()) {
      onSubmit(input.trim());
      setValue('');
    }
  };

  if (disabled) {
    return (
      <Box>
        <Text color="gray">heimdall&gt; </Text>
        <Text color="yellow">Processing...</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text color="cyan">heimdall&gt; </Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder={placeholder}
      />
    </Box>
  );
}
