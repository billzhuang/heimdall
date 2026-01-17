import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { NamespaceSelector } from '../../components/NamespaceSelector.js';

// Mock the kubeconfigParser module
vi.mock('../../kubeconfigParser.js', () => ({
  fetchNamespaces: vi.fn().mockResolvedValue(['default', 'kube-system', 'production']),
}));

describe('NamespaceSelector', () => {
  const defaultProps = {
    context: 'test-context',
    kubeconfigPath: '/test/kubeconfig',
    selectedNamespace: 'default',
    onSelect: vi.fn(),
    onCancel: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render loading state initially', () => {
    const { lastFrame } = render(<NamespaceSelector {...defaultProps} />);
    expect(lastFrame()).toContain('Loading namespaces');
  });
});
