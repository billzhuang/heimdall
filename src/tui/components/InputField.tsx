import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { filterSlashCommands } from '../commandParser.js';

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
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showAutocomplete, setShowAutocomplete] = useState(false);

  // Get filtered commands when input starts with /
  const suggestions = value.startsWith('/') ? filterSlashCommands(value) : [];
  const hasSuggestions = suggestions.length > 0;

  // Handle keyboard navigation for autocomplete
  useInput((input, key) => {
    if (!showAutocomplete || !hasSuggestions) return;

    if (key.downArrow) {
      setSelectedIndex(prev => (prev + 1) % suggestions.length);
    } else if (key.upArrow) {
      setSelectedIndex(prev => (prev - 1 + suggestions.length) % suggestions.length);
    } else if (key.tab) {
      // Tab to autocomplete
      setValue(suggestions[selectedIndex].command);
      setShowAutocomplete(false);
    }
  }, { isActive: showAutocomplete && hasSuggestions });

  const handleChange = (newValue: string) => {
    setValue(newValue);
    setSelectedIndex(0);
    setShowAutocomplete(newValue.startsWith('/') && newValue.length >= 1);
  };

  const handleSubmit = (input: string) => {
    if (input.trim()) {
      onSubmit(input.trim());
      setValue('');
      setShowAutocomplete(false);
    }
  };

  if (disabled) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="gray">heimdall&gt; </Text>
          <Text color="yellow">Processing...</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {showAutocomplete && hasSuggestions && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          marginBottom={1}
        >
          <Text color="gray" dimColor>Slash commands (↑↓ navigate, Tab complete):</Text>
          {suggestions.map((item, index) => (
            <Box key={item.command}>
              <Text color={index === selectedIndex ? 'cyan' : 'white'}>
                {index === selectedIndex ? '❯ ' : '  '}
                {item.command}
              </Text>
              <Text color="gray"> - {item.description}</Text>
            </Box>
          ))}
        </Box>
      )}
      <Box>
        <Text color="cyan">heimdall&gt; </Text>
        <TextInput
          value={value}
          onChange={handleChange}
          onSubmit={handleSubmit}
          placeholder={placeholder}
        />
      </Box>
    </Box>
  );
}
