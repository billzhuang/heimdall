import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ContextSelector } from '../../components/ContextSelector.js';
import { ModelSelector } from '../../components/ModelSelector.js';
import { MODEL_MAP } from '../../../constants.js';

describe('ContextSelector', () => {
  it('should render context list', () => {
    const { lastFrame } = render(
      <ContextSelector
        contexts={['context-1', 'context-2', 'context-3']}
        currentContext="context-1"
        selectedContext={null}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    );
    
    const frame = lastFrame();
    expect(frame).toContain('context-1');
    expect(frame).toContain('context-2');
    expect(frame).toContain('context-3');
  });

  it('should mark current context', () => {
    const { lastFrame } = render(
      <ContextSelector
        contexts={['context-1', 'context-2']}
        currentContext="context-1"
        selectedContext={null}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    );
    
    expect(lastFrame()).toContain('[current]');
  });

  it('should show title', () => {
    const { lastFrame } = render(
      <ContextSelector
        contexts={['context-1']}
        currentContext={null}
        selectedContext={null}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    );
    
    expect(lastFrame()).toContain('Select Kubernetes Context');
  });
});

describe('ModelSelector', () => {
  it('should render all models from MODEL_MAP', () => {
    const { lastFrame } = render(
      <ModelSelector
        selectedModel="sonnet"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    );
    
    const frame = lastFrame();
    for (const [, info] of Object.entries(MODEL_MAP)) {
      expect(frame).toContain(info.label);
    }
  });

  it('should mark current model', () => {
    const { lastFrame } = render(
      <ModelSelector
        selectedModel="opus"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    );
    
    expect(lastFrame()).toContain('[current]');
  });

  it('should show title', () => {
    const { lastFrame } = render(
      <ModelSelector
        selectedModel="sonnet"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    );
    
    expect(lastFrame()).toContain('Select LLM Model');
  });
});
