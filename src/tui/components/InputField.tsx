import React, { useState, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { filterSlashCommands } from '../commandParser.js';

export interface InputFieldProps {
  onSubmit: (input: string) => void;
  disabled?: boolean;
}

export function InputField({
  onSubmit,
  disabled = false,
}: InputFieldProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  
  // Track if we should intercept the next submit
  const interceptSubmitRef = useRef(false);

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
      // Tab to autocomplete - add space at end so cursor is at the end
      const cmd = suggestions[selectedIndex].command + ' ';
      setValue(cmd);
      setShowAutocomplete(false);
    } else if (key.return) {
      // Enter to execute selected command directly
      const selectedCmd = suggestions[selectedIndex].command;
      setValue('');
      setShowAutocomplete(false);
      setSelectedIndex(0);
      onSubmit(selectedCmd);
      interceptSubmitRef.current = true;
    }
  }, { isActive: showAutocomplete && hasSuggestions });

  const handleChange = (newValue: string) => {
    setValue(newValue);
    setSelectedIndex(0);
    setShowAutocomplete(newValue.startsWith('/') && newValue.length >= 1);
  };

  const handleSubmit = (input: string) => {
    // Skip if we already handled this via autocomplete Enter
    if (interceptSubmitRef.current) {
      interceptSubmitRef.current = false;
      return;
    }
    
    if (input.trim()) {
      onSubmit(input.trim());
      setValue('');
      setShowAutocomplete(false);
    }
  };

  if (disabled) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color="cyan" bold>{'>'}</Text>
        <Text color="yellow"> Processing...</Text>
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
          <Text color="gray" dimColor>↑↓ navigate · Enter select · Tab complete · Esc cancel</Text>
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
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text color="cyan" bold>{'>'}</Text>
        <Text> </Text>
        <TextInput
          value={value}
          onChange={handleChange}
          onSubmit={handleSubmit}
          placeholder=""
        />
      </Box>
    </Box>
  );
}
