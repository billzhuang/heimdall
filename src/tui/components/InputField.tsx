import React, { useState, useRef, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { filterSlashCommands } from '../commandParser.js';
import { PromptInput } from './PromptInput.js';

export interface InputFieldProps {
  onSubmit: (input: string) => void;
  onQuit?: () => void;
  disabled?: boolean;
}

export function InputField({
  onSubmit,
  onQuit,
  disabled = false,
}: InputFieldProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  
  // Track if we should intercept the next submit
  const interceptSubmitRef = useRef(false);

  // Force re-render key to reset TextInput cursor position
  const [inputKey, setInputKey] = useState(0);

  // Guard against input during mount - prevents phantom keystrokes from selector transitions
  const [isReady, setIsReady] = useState(false);
  useEffect(() => {
    // Small delay to let any buffered input from selector close drain
    const timer = setTimeout(() => {
      setIsReady(true);
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  // Get filtered commands when input starts with /
  const suggestions = value.startsWith('/') ? filterSlashCommands(value) : [];
  const hasSuggestions = suggestions.length > 0;

  // Handle keyboard navigation for autocomplete
  useInput((_input, key) => {
    if (!showAutocomplete || !hasSuggestions) return;

    if (key.escape) {
      // ESC to cancel autocomplete
      setShowAutocomplete(false);
      setSelectedIndex(0);
    } else if (key.downArrow) {
      setSelectedIndex(prev => (prev + 1) % suggestions.length);
    } else if (key.upArrow) {
      setSelectedIndex(prev => (prev - 1 + suggestions.length) % suggestions.length);
    } else if (key.tab) {
      // Tab to autocomplete - add space at end so cursor is at the end
      const cmd = suggestions[selectedIndex].command + ' ';
      setValue(cmd);
      setShowAutocomplete(false);
      // Force TextInput to remount so cursor goes to end
      setInputKey(prev => prev + 1);
    } else if (key.return) {
      // Enter to execute selected command directly
      const selectedCmd = suggestions[selectedIndex].command;
      setValue('');
      setShowAutocomplete(false);
      setSelectedIndex(0);
      onSubmit(selectedCmd);
      interceptSubmitRef.current = true;
    }
  }, { isActive: isReady && showAutocomplete && hasSuggestions });

  // Handle Ctrl+C: clear input if there's content, otherwise quit
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (value.length > 0) {
        setValue('');
        setShowAutocomplete(false);
      } else if (onQuit) {
        onQuit();
      }
    }
  }, { isActive: isReady });

  const handleChange = (newValue: string) => {
    // Ignore input during mount guard period
    if (!isReady) return;
    
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
    
    // Ignore input during mount guard period
    if (!isReady) return;
    
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
    <Box flexDirection="column" width="100%">
      {showAutocomplete && hasSuggestions && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          marginBottom={1}
          width="100%"
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
      <Box borderStyle="round" borderColor="cyan" paddingX={1} width="100%">
        <Text color="cyan" bold>{'>'}</Text>
        <Text> </Text>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <PromptInput
            key={inputKey}
            value={value}
            onChange={handleChange}
            onSubmit={handleSubmit}
            placeholder=""
            isActive={isReady}
            suppressSubmit={showAutocomplete && hasSuggestions}
            suppressAutocompleteKeys={showAutocomplete && hasSuggestions}
          />
        </Box>
      </Box>
    </Box>
  );
}
