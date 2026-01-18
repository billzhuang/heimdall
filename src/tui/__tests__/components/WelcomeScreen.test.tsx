import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { WelcomeScreen } from '../../components/WelcomeScreen.js';
import { WELCOME_TIPS } from '../../constants.js';

describe('WelcomeScreen', () => {
  // Test ASCII art renders (Requirement 1.2)
  it('should render ASCII art containing Heimdall text', () => {
    const { lastFrame } = render(
      <WelcomeScreen
        version="0.1.0"
        context="my-cluster"
        namespace="default"
        onSubmit={() => {}}
      />
    );
    
    // ASCII art contains "Heimdall" spelled out in ASCII characters
    expect(lastFrame()).toContain('Heimdall');
  });

  // Test version string renders (Requirement 1.3)
  it('should render version string in format "Heimdall vX.Y.Z"', () => {
    const { lastFrame } = render(
      <WelcomeScreen
        version="0.1.0"
        context="my-cluster"
        namespace="default"
        onSubmit={() => {}}
      />
    );
    
    expect(lastFrame()).toContain('v0.1.0');
  });

  // Test greeting renders (Requirement 1.4)
  it('should render Welcome! greeting message', () => {
    const { lastFrame } = render(
      <WelcomeScreen
        version="0.1.0"
        context="my-cluster"
        namespace="default"
        onSubmit={() => {}}
      />
    );
    
    expect(lastFrame()).toContain('Welcome!');
  });

  // Test tips panel shows required commands (Requirements 2.1, 2.2)
  it('should render tips panel with all required commands', () => {
    const { lastFrame } = render(
      <WelcomeScreen
        version="0.1.0"
        context="my-cluster"
        namespace="default"
        onSubmit={() => {}}
      />
    );
    
    const frame = lastFrame();
    
    // Verify all required commands are displayed
    expect(frame).toContain('/ctx');
    expect(frame).toContain('/ns');
    expect(frame).toContain('/model');
    expect(frame).toContain('/help');
    expect(frame).toContain('/clear');
    expect(frame).toContain('/exit');
  });

  // Test tips panel header renders
  it('should render tips panel header', () => {
    const { lastFrame } = render(
      <WelcomeScreen
        version="0.1.0"
        context="my-cluster"
        namespace="default"
        onSubmit={() => {}}
      />
    );
    
    expect(lastFrame()).toContain('Tips for getting started');
  });

  // Test each command has a description (Requirement 2.3)
  it('should render descriptions for all commands', () => {
    const { lastFrame } = render(
      <WelcomeScreen
        version="0.1.0"
        context="my-cluster"
        namespace="default"
        onSubmit={() => {}}
      />
    );
    
    const frame = lastFrame();
    
    // Verify all command descriptions from WELCOME_TIPS are displayed
    for (const tip of WELCOME_TIPS) {
      expect(frame).toContain(tip.description);
    }
  });

  // Test context displays when provided (Requirement 3.1)
  it('should display context when provided', () => {
    const { lastFrame } = render(
      <WelcomeScreen
        version="0.1.0"
        context="prod-cluster"
        namespace="default"
        onSubmit={() => {}}
      />
    );
    
    expect(lastFrame()).toContain('Context: prod-cluster');
  });

  // Test namespace displays when provided (Requirement 3.2)
  it('should display namespace when provided', () => {
    const { lastFrame } = render(
      <WelcomeScreen
        version="0.1.0"
        context="my-cluster"
        namespace="kube-system"
        onSubmit={() => {}}
      />
    );
    
    expect(lastFrame()).toContain('Namespace: kube-system');
  });

  // Test hint shows when context is null (Requirement 3.3)
  it('should show hint when context is null', () => {
    const { lastFrame } = render(
      <WelcomeScreen
        version="0.1.0"
        context={null}
        namespace="default"
        onSubmit={() => {}}
      />
    );
    
    expect(lastFrame()).toContain('Configure kubeconfig to get started');
  });

  // Test context/namespace NOT shown when context is null
  it('should not show context/namespace labels when context is null', () => {
    const { lastFrame } = render(
      <WelcomeScreen
        version="0.1.0"
        context={null}
        namespace="default"
        onSubmit={() => {}}
      />
    );
    
    const frame = lastFrame();
    expect(frame).not.toContain('Context:');
    expect(frame).not.toContain('Namespace:');
  });

  // Test no billing/API usage text (Requirement 4.1)
  it('should NOT contain billing or API usage information', () => {
    const { lastFrame } = render(
      <WelcomeScreen
        version="0.1.0"
        context="my-cluster"
        namespace="default"
        onSubmit={() => {}}
      />
    );
    
    const frame = lastFrame();
    expect(frame).not.toContain('billing');
    expect(frame).not.toContain('Billing');
    expect(frame).not.toContain('API usage');
    expect(frame).not.toContain('usage');
    expect(frame).not.toContain('credits');
  });

  // Test no recent activity text (Requirement 4.2)
  it('should NOT contain recent activity or history information', () => {
    const { lastFrame } = render(
      <WelcomeScreen
        version="0.1.0"
        context="my-cluster"
        namespace="default"
        onSubmit={() => {}}
      />
    );
    
    const frame = lastFrame();
    expect(frame).not.toContain('recent');
    expect(frame).not.toContain('Recent');
    expect(frame).not.toContain('history');
    expect(frame).not.toContain('History');
    expect(frame).not.toContain('activity');
  });

  // Test no folder/directory path (Requirement 4.3)
  it('should NOT contain folder or directory path information', () => {
    const { lastFrame } = render(
      <WelcomeScreen
        version="0.1.0"
        context="my-cluster"
        namespace="default"
        onSubmit={() => {}}
      />
    );
    
    const frame = lastFrame();
    expect(frame).not.toContain('folder');
    expect(frame).not.toContain('Folder');
    expect(frame).not.toContain('directory');
    expect(frame).not.toContain('Directory');
    expect(frame).not.toContain('path');
    expect(frame).not.toContain('Path');
  });

  // Test InputField is rendered (shows prompt character)
  it('should render InputField with prompt', () => {
    const { lastFrame } = render(
      <WelcomeScreen
        version="0.1.0"
        context="my-cluster"
        namespace="default"
        onSubmit={() => {}}
      />
    );
    
    // InputField renders a ">" prompt
    expect(lastFrame()).toContain('>');
  });

  // Test disabled prop shows processing state
  it('should show processing state when disabled', () => {
    const { lastFrame } = render(
      <WelcomeScreen
        version="0.1.0"
        context="my-cluster"
        namespace="default"
        onSubmit={() => {}}
        disabled={true}
      />
    );
    
    // InputField shows "Processing..." when disabled
    expect(lastFrame()).toContain('Processing...');
  });
});
