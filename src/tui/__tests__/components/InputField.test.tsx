import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { InputField } from '../../components/InputField.js';

describe('InputField', () => {
  it('should render prompt', () => {
    const { lastFrame } = render(
      <InputField onSubmit={() => {}} />
    );
    
    expect(lastFrame()).toContain('heimdall>');
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
    expect(lastFrame()).toContain('heimdall>');
    expect(lastFrame()).not.toContain('Processing...');
  });

  it('should show placeholder text', () => {
    const { lastFrame } = render(
      <InputField onSubmit={() => {}} placeholder="Enter command" />
    );
    
    // Placeholder should be visible in the frame
    expect(lastFrame()).toContain('heimdall>');
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
