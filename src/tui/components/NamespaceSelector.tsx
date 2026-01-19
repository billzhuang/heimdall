import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { Selector, type SelectorItem } from './Selector.js';
import { fetchNamespaces } from '../kubeconfigParser.js';

export interface NamespaceSelectorProps {
  context: string;
  kubeconfigPath: string;
  selectedNamespace: string;
  onSelect: (namespace: string) => void;
  onCancel: () => void;
}

type LoadState = 'init' | 'loading' | 'loaded' | 'error';

export function NamespaceSelector({
  context,
  kubeconfigPath,
  selectedNamespace,
  onSelect,
  onCancel,
}: NamespaceSelectorProps): React.ReactElement {
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('init');
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const mountedRef = useRef(true);

  // Defer loading to avoid race conditions during rapid selector switching
  useEffect(() => {
    mountedRef.current = true;
    
    // Small delay before starting load to let component stabilize
    const initTimer = setTimeout(() => {
      if (!mountedRef.current) return;
      setLoadState('loading');
    }, 16); // One frame
    
    return () => {
      mountedRef.current = false;
      clearTimeout(initTimer);
    };
  }, []);

  // Separate effect for actual loading
  useEffect(() => {
    if (loadState !== 'loading') return;
    
    let cancelled = false;

    async function loadNamespaces() {
      try {
        const ns = await fetchNamespaces(context, kubeconfigPath);
        if (cancelled || !mountedRef.current) return;
        
        setNamespaces(ns);
        setLoadState('loaded');
        
        // Set initial index based on selected namespace
        if (selectedNamespace !== 'all') {
          const idx = ns.indexOf(selectedNamespace);
          if (idx >= 0) {
            setSelectedIndex(idx + 1); // +1 for "all" option
          }
        }
      } catch (err) {
        if (cancelled || !mountedRef.current) return;
        setError(err instanceof Error ? err.message : 'Failed to fetch namespaces');
        setLoadState('error');
      }
    }

    loadNamespaces();
    return () => { cancelled = true; };
  }, [loadState, context, kubeconfigPath, selectedNamespace]);

  // Allow escape during loading
  useInput((_input, key) => {
    if (key.escape && (loadState === 'init' || loadState === 'loading')) {
      onCancel();
    }
  });

  // Init/Loading state
  if (loadState === 'init' || loadState === 'loading') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
        <Text bold color="cyan">Namespaces</Text>
        <Text color="yellow">Loading...</Text>
        <Text color="gray">Press Esc to cancel</Text>
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

  if (loadState === 'error') {
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
