import React, { useEffect, useState } from 'react';
import { Text, useInput } from 'ink';
import chalk from 'chalk';

export interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  isActive?: boolean;
  suppressSubmit?: boolean;
  suppressAutocompleteKeys?: boolean;
}

const isWhitespace = (char: string) => /\s/.test(char);

const moveWordLeft = (value: string, cursorOffset: number) => {
  if (cursorOffset <= 0) return 0;
  let i = Math.min(cursorOffset - 1, value.length - 1);
  while (i > 0 && isWhitespace(value[i])) {
    i--;
  }
  while (i > 0 && !isWhitespace(value[i - 1])) {
    i--;
  }
  return i;
};

const moveWordRight = (value: string, cursorOffset: number) => {
  if (cursorOffset >= value.length) return value.length;
  let i = cursorOffset;
  while (i < value.length && isWhitespace(value[i])) {
    i++;
  }
  while (i < value.length && !isWhitespace(value[i])) {
    i++;
  }
  return i;
};

export function PromptInput({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  isActive = true,
  suppressSubmit = false,
  suppressAutocompleteKeys = false,
}: PromptInputProps): React.ReactElement {
  const [cursorOffset, setCursorOffset] = useState(value.length);
  const [cursorWidth, setCursorWidth] = useState(0);

  useEffect(() => {
    if (!isActive) return;
    if (cursorOffset > value.length) {
      setCursorOffset(value.length);
      setCursorWidth(0);
    }
  }, [value, cursorOffset, isActive]);

  useInput((input, key) => {
    if (!isActive) return;

    if (
      suppressAutocompleteKeys &&
      (key.upArrow || key.downArrow || key.tab || key.return)
    ) {
      return;
    }

    if (key.tab || (key.shift && key.tab)) {
      return;
    }

    if (key.return) {
      if (!suppressSubmit && onSubmit) {
        onSubmit(value);
      }
      return;
    }

    let nextCursorOffset = cursorOffset;
    let nextCursorWidth = 0;
    let nextValue = value;
    let handled = false;

    if (key.home || (key.ctrl && input === 'a') || (key.meta && input === '<')) {
      nextCursorOffset = 0;
      handled = true;
    } else if (
      key.end ||
      (key.ctrl && input === 'e') ||
      (key.meta && input === '>')
    ) {
      nextCursorOffset = value.length;
      handled = true;
    } else if (key.meta && input === 'b') {
      nextCursorOffset = moveWordLeft(value, cursorOffset);
      handled = true;
    } else if (key.meta && input === 'f') {
      nextCursorOffset = moveWordRight(value, cursorOffset);
      handled = true;
    } else if (key.meta && key.leftArrow) {
      nextCursorOffset = moveWordLeft(value, cursorOffset);
      handled = true;
    } else if (key.meta && key.rightArrow) {
      nextCursorOffset = moveWordRight(value, cursorOffset);
      handled = true;
    } else if (key.leftArrow) {
      nextCursorOffset = cursorOffset - 1;
      handled = true;
    } else if (key.rightArrow) {
      nextCursorOffset = cursorOffset + 1;
      handled = true;
    } else if (key.backspace || key.delete) {
      if (cursorOffset > 0) {
        nextValue =
          value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
        nextCursorOffset = cursorOffset - 1;
        handled = true;
      } else {
        handled = true;
      }
    } else if (input.length > 0) {
      nextValue = value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
      nextCursorOffset = cursorOffset + input.length;
      if (input.length > 1) {
        nextCursorWidth = input.length;
      }
      handled = true;
    }

    if (!handled) return;

    if (nextCursorOffset < 0) {
      nextCursorOffset = 0;
    }
    if (nextCursorOffset > nextValue.length) {
      nextCursorOffset = nextValue.length;
    }

    setCursorOffset(nextCursorOffset);
    setCursorWidth(nextCursorWidth);

    if (nextValue !== value) {
      onChange(nextValue);
    }
  }, { isActive });

  const showCursor = isActive;
  const cursorActualWidth = cursorWidth;

  let renderedValue = value;
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

  if (showCursor) {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : chalk.inverse(' ');
    renderedValue = value.length > 0 ? '' : chalk.inverse(' ');

    let i = 0;
    for (const char of value) {
      renderedValue +=
        i >= cursorOffset - cursorActualWidth && i <= cursorOffset
          ? chalk.inverse(char)
          : char;
      i++;
    }

    if (value.length > 0 && cursorOffset === value.length) {
      renderedValue += chalk.inverse(' ');
    }
  }

  return (
    <Text wrap="wrap">
      {placeholder
        ? value.length > 0
          ? renderedValue
          : renderedPlaceholder
        : renderedValue}
    </Text>
  );
}
