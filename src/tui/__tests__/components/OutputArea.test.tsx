import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { OutputArea } from '../../components/OutputArea.js';
import type { OutputMessage } from '../../agentRunner.js';

describe('OutputArea', () => {
  it('should render empty state when no messages', () => {
    const { lastFrame } = render(<OutputArea messages={[]} />);
    
    expect(lastFrame()).toContain('No messages yet');
  });

  it('should render messages', () => {
    const messages: OutputMessage[] = [
      {
        id: '1',
        type: 'system',
        content: 'System initialized',
        timestamp: new Date(),
      },
      {
        id: '2',
        type: 'assistant',
        content: 'Hello, how can I help?',
        timestamp: new Date(),
      },
    ];

    const { lastFrame } = render(<OutputArea messages={messages} />);
    
    const frame = lastFrame();
    expect(frame).toContain('System initialized');
    expect(frame).toContain('Hello, how can I help?');
  });

  it('should render tool messages with tool name', () => {
    const messages: OutputMessage[] = [
      {
        id: '1',
        type: 'tool',
        content: 'Running kubectl command',
        timestamp: new Date(),
        metadata: {
          toolName: 'Bash',
          command: 'kubectl get pods',
        },
      },
    ];

    const { lastFrame } = render(<OutputArea messages={messages} />);
    
    const frame = lastFrame();
    expect(frame).toContain('[Bash]');
    expect(frame).toContain('kubectl get pods');
  });

  it('should render error messages', () => {
    const messages: OutputMessage[] = [
      {
        id: '1',
        type: 'error',
        content: 'Something went wrong',
        timestamp: new Date(),
      },
    ];

    const { lastFrame } = render(<OutputArea messages={messages} />);
    
    expect(lastFrame()).toContain('Something went wrong');
  });

  it('should render user messages', () => {
    const messages: OutputMessage[] = [
      {
        id: '1',
        type: 'user',
        content: 'Show me the pods',
        timestamp: new Date(),
      },
    ];

    const { lastFrame } = render(<OutputArea messages={messages} />);
    
    expect(lastFrame()).toContain('Show me the pods');
  });
});
