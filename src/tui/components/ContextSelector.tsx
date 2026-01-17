import React, { useState } from 'react';
import { Selector, type SelectorItem } from './Selector.js';

export interface ContextSelectorProps {
  contexts: string[];
  currentContext: string | null;
  selectedContext: string | null;
  onSelect: (context: string) => void;
  onCancel: () => void;
}

export function ContextSelector({
  contexts,
  currentContext,
  selectedContext,
  onSelect,
  onCancel,
}: ContextSelectorProps): React.ReactElement {
  const items: SelectorItem<string>[] = contexts.map(ctx => ({
    value: ctx,
    label: ctx.length > 60 ? ctx.substring(0, 57) + '...' : ctx,
    isCurrent: ctx === currentContext,
  }));

  // Find initial selected index
  const initialIndex = selectedContext
    ? contexts.indexOf(selectedContext)
    : currentContext
      ? contexts.indexOf(currentContext)
      : 0;

  const [selectedIndex, setSelectedIndex] = useState(
    initialIndex >= 0 ? initialIndex : 0
  );

  return (
    <Selector
      items={items}
      selectedIndex={selectedIndex}
      onSelect={onSelect}
      onCancel={onCancel}
      onNavigate={setSelectedIndex}
      title="Select Kubernetes Context"
    />
  );
}
