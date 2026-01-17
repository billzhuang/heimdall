import React, { useState } from 'react';
import { Selector, type SelectorItem } from './Selector.js';
import { getModelOptions } from '../useAppState.js';

export interface ModelSelectorProps {
  selectedModel: string;
  onSelect: (model: string) => void;
  onCancel: () => void;
}

export function ModelSelector({
  selectedModel,
  onSelect,
  onCancel,
}: ModelSelectorProps): React.ReactElement {
  const modelOptions = getModelOptions();
  
  const items: SelectorItem<string>[] = modelOptions.map(opt => ({
    value: opt.value,
    label: opt.label,
    isCurrent: opt.value === selectedModel,
  }));

  // Find initial selected index
  const initialIndex = modelOptions.findIndex(opt => opt.value === selectedModel);
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
      title="Select LLM Model"
    />
  );
}
