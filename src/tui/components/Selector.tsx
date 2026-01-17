import React from 'react';
import { Box, Text, useInput } from 'ink';

export interface SelectorItem<T> {
  value: T;
  label: string;
  description?: string;
  isCurrent?: boolean;
}

export interface SelectorProps<T> {
  items: SelectorItem<T>[];
  selectedIndex: number;
  onSelect: (value: T) => void;
  onCancel: () => void;
  onNavigate: (index: number) => void;
  title: string;
}

export function Selector<T>({
  items,
  selectedIndex,
  onSelect,
  onCancel,
  onNavigate,
  title,
}: SelectorProps<T>): React.ReactElement {
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      if (items[selectedIndex]) {
        onSelect(items[selectedIndex].value);
      }
      return;
    }

    if (key.upArrow) {
      const newIndex = selectedIndex > 0 ? selectedIndex - 1 : items.length - 1;
      onNavigate(newIndex);
      return;
    }

    if (key.downArrow) {
      const newIndex = selectedIndex < items.length - 1 ? selectedIndex + 1 : 0;
      onNavigate(newIndex);
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">{title}</Text>
      </Box>
      <Box flexDirection="column">
        {items.map((item, index) => {
          const isSelected = index === selectedIndex;
          const indicator = isSelected ? '❯' : ' ';
          const currentMarker = item.isCurrent ? ' [current]' : '';
          
          return (
            <Box key={String(item.value)}>
              <Text color={isSelected ? 'cyan' : 'white'}>
                {indicator} {item.label}{currentMarker}
              </Text>
              {item.description && (
                <Text color="gray"> - {item.description}</Text>
              )}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">↑↓ navigate • Enter select • Esc cancel</Text>
      </Box>
    </Box>
  );
}
