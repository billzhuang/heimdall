import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Selector, type SelectorItem } from './Selector.js';
import { fetchNamespaces } from '../kubeconfigParser.js';

export interface NamespaceSelectorProps {
  context: string;
  kubeconfigPath: string;
  selectedNamespace: string;
  onSelect: (namespace: string) => void;
  onCancel: () => void;
}

export function NamespaceSelector({
  context,
  kubeconfigPath,
  selectedNamespace,
  onSelect,
  onCancel,
}: NamespaceSelectorProps): React.ReactElement {
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadNamespaces() {
      try {
        const ns = await fetchNamespaces(context, kubeconfigPath);
        if (!cancelled) {
          setNamespaces(ns);
          setLoading(false);
          
          // Set initial index based on selected namespace
          if (selectedNamespace !== 'all') {
            const idx = ns.indexOf(selectedNamespace);
            if (idx >= 0) {
              setSelectedIndex(idx + 1); // +1 for "all" option
            }
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to fetch namespaces');
          setLoading(false);
        }
      }
    }

    loadNamespaces();
    return () => { cancelled = true; };
  }, [context, kubeconfigPath, selectedNamespace]);

  if (loading) {
    return (
      <Box borderStyle="round" borderColor="cyan" padding={1}>
        <Text color="yellow">Loading namespaces...</Text>
      </Box>
    );
  }

  // Build items with "all" at top
  const items: SelectorItem<string>[] = [
    { value: 'all', label: 'All namespaces', isCurrent: selectedNamespace === 'all' },
    ...namespaces.map(ns => ({
      value: ns,
      label: ns,
      isCurrent: ns === selectedNamespace,
    })),
  ];

  if (error) {
    // Show error but still allow selection with manual entry hint
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" padding={1}>
        <Text color="yellow">⚠️ {error}</Text>
        <Text color="gray">Showing "all namespaces" option only</Text>
        <Box marginTop={1}>
          <Selector
            items={[{ value: 'all', label: 'All namespaces' }]}
            selectedIndex={0}
            onSelect={onSelect}
            onCancel={onCancel}
            onNavigate={() => {}}
            title="Select Namespace"
          />
        </Box>
      </Box>
    );
  }

  return (
    <Selector
      items={items}
      selectedIndex={selectedIndex}
      onSelect={onSelect}
      onCancel={onCancel}
      onNavigate={setSelectedIndex}
      title="Select Namespace"
    />
  );
}
