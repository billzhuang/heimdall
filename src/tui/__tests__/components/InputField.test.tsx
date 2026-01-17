import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { InputField } from '../../components/InputField.js';

describe('InputField', () => {
  it('should render prompt', () => {
    const { lastFrame } = render(
      <InputField onSubmit={() => {}} />
    );
    
    // Claude Code style prompt
    expect(lastFrame()).toContain('>');
  });

  it('should show processing state when disabled', () => {
    const { lastFrame } = render(
      <InputField onSubmit={() => {}} disabled={true} />
    );
    
    expect(lastFrame()).toContain('Processing...');
  });

  it('should render input area when not disabled', () => {
    const { lastFrame } = render(
      <InputField onSubmit={() => {}} disabled={false} />
    );
    
    // Should show prompt but not processing
    expect(lastFrame()).toContain('>');
    expect(lastFrame()).not.toContain('Processing...');
  });

  it('should render with border', () => {
    const { lastFrame } = render(
      <InputField onSubmit={() => {}} />
    );
    
    // Should have border characters (round style uses these)
    expect(lastFrame()).toContain('╭');
    expect(lastFrame()).toContain('╯');
  });

  it('should not call onSubmit for empty input on enter', () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <InputField onSubmit={onSubmit} />
    );
    
    // Just press enter without typing
    stdin.write('\r');
    
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
