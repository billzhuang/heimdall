import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { StatusBar } from '../../components/StatusBar.js';

describe('StatusBar', () => {
  it('should render context value', () => {
    const { lastFrame } = render(
      <StatusBar context="my-cluster" namespace="default" model="sonnet" />
    );
    
    expect(lastFrame()).toContain('my-cluster');
  });

  it('should render "not set" when context is null', () => {
    const { lastFrame } = render(
      <StatusBar context={null} namespace="default" model="sonnet" />
    );
    
    expect(lastFrame()).toContain('not set');
  });

  it('should render namespace value', () => {
    const { lastFrame } = render(
      <StatusBar context="my-cluster" namespace="kube-system" model="sonnet" />
    );
    
    expect(lastFrame()).toContain('kube-system');
  });

  it('should render "all" namespace', () => {
    const { lastFrame } = render(
      <StatusBar context="my-cluster" namespace="all" model="sonnet" />
    );
    
    expect(lastFrame()).toContain('all');
  });

  it('should render model value', () => {
    const { lastFrame } = render(
      <StatusBar context="my-cluster" namespace="default" model="opus" />
    );
    
    expect(lastFrame()).toContain('opus');
  });

  it('should render all three values together', () => {
    const { lastFrame } = render(
      <StatusBar context="prod-cluster" namespace="production" model="haiku" />
    );
    
    const frame = lastFrame();
    expect(frame).toContain('prod-cluster');
    expect(frame).toContain('production');
    expect(frame).toContain('haiku');
  });

  it('should render hint when provided', () => {
    const { lastFrame } = render(
      <StatusBar context="my-cluster" namespace="default" model="sonnet" hint="No default context found" />
    );
    
    expect(lastFrame()).toContain('No default context found');
  });

  it('should not render hint when null', () => {
    const { lastFrame } = render(
      <StatusBar context="my-cluster" namespace="default" model="sonnet" hint={null} />
    );
    
    expect(lastFrame()).not.toContain('⚠️');
  });
});
