import { describe, it, expect, vi } from 'vitest';
import { getSessionFilePath, formatSessionList, SessionInfo } from '../sessionManager.js';

// Mock fs/promises to avoid actual file system operations
vi.mock('fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  stat: vi.fn(),
}));

describe('sessionManager', () => {
  describe('getSessionFilePath', () => {
    it('should return valid path for alphanumeric session ID', () => {
      const path = getSessionFilePath('abc123');
      expect(path).toContain('abc123.jsonl');
    });

    it('should allow hyphens in session ID', () => {
      const path = getSessionFilePath('session-123-abc');
      expect(path).toContain('session-123-abc.jsonl');
    });

    it('should allow underscores in session ID', () => {
      const path = getSessionFilePath('session_123_abc');
      expect(path).toContain('session_123_abc.jsonl');
    });

    it('should throw for path traversal attempt with ..', () => {
      expect(() => getSessionFilePath('../etc/passwd')).toThrow('Invalid session ID');
    });

    it('should throw for path traversal attempt with /', () => {
      expect(() => getSessionFilePath('foo/bar')).toThrow('Invalid session ID');
    });

    it('should throw for path traversal attempt with backslash', () => {
      expect(() => getSessionFilePath('foo\\bar')).toThrow('Invalid session ID');
    });

    it('should throw for empty session ID', () => {
      expect(() => getSessionFilePath('')).toThrow('Invalid session ID');
    });

    it('should throw for session ID with spaces', () => {
      expect(() => getSessionFilePath('foo bar')).toThrow('Invalid session ID');
    });

    it('should throw for session ID with special characters', () => {
      expect(() => getSessionFilePath('foo@bar')).toThrow('Invalid session ID');
      expect(() => getSessionFilePath('foo:bar')).toThrow('Invalid session ID');
      expect(() => getSessionFilePath('foo$bar')).toThrow('Invalid session ID');
    });
  });

  describe('formatSessionList', () => {
    it('should return message for empty session list', () => {
      const result = formatSessionList([]);
      expect(result).toBe('No saved sessions found.');
    });

    it('should format single session correctly', () => {
      const sessions: SessionInfo[] = [{
        sessionId: 'abc12345678',
        timestamp: new Date(),
        firstMessage: 'Hello world',
        messageCount: 5,
        filePath: '/path/to/session.jsonl',
        context: 'prod-cluster',
        namespace: 'default',
      }];
      
      const result = formatSessionList(sessions);
      expect(result).toContain('📋 Recent Sessions');
      expect(result).toContain('Hello world');
      expect(result).toContain('abc12345');
      expect(result).toContain('5 messages');
      expect(result).toContain('[prod-cluster/default]');
    });

    it('should show named session with pin emoji', () => {
      const sessions: SessionInfo[] = [{
        sessionId: 'abc12345678',
        timestamp: new Date(),
        firstMessage: 'Hello world',
        messageCount: 3,
        filePath: '/path/to/session.jsonl',
        name: 'My Important Session',
      }];
      
      const result = formatSessionList(sessions);
      expect(result).toContain('📌');
      expect(result).toContain('My Important Session');
    });

    it('should sanitize control characters from display text', () => {
      const sessions: SessionInfo[] = [{
        sessionId: 'abc12345678',
        timestamp: new Date(),
        firstMessage: 'Hello\x00World\x1FTest',
        messageCount: 1,
        filePath: '/path/to/session.jsonl',
      }];
      
      const result = formatSessionList(sessions);
      // Should not contain control characters
      expect(result).toContain('HelloWorldTest');
    });

    it('should sanitize control characters from session name', () => {
      const sessions: SessionInfo[] = [{
        sessionId: 'abc12345678',
        timestamp: new Date(),
        firstMessage: 'Original message',
        messageCount: 1,
        filePath: '/path/to/session.jsonl',
        name: 'Name\x00with\x1Fcontrol\x7Fchars',
      }];
      
      const result = formatSessionList(sessions);
      expect(result).toContain('Namewithcontrolchars');
    });

    it('should use default namespace when not provided', () => {
      const sessions: SessionInfo[] = [{
        sessionId: 'abc12345678',
        timestamp: new Date(),
        firstMessage: 'Test',
        messageCount: 1,
        filePath: '/path/to/session.jsonl',
        context: 'my-cluster',
        namespace: undefined,
      }];
      
      const result = formatSessionList(sessions);
      expect(result).toContain('[my-cluster/default]');
    });

    it('should not show context info when context is missing', () => {
      const sessions: SessionInfo[] = [{
        sessionId: 'abc12345678',
        timestamp: new Date(),
        firstMessage: 'Test',
        messageCount: 1,
        filePath: '/path/to/session.jsonl',
      }];
      
      const result = formatSessionList(sessions);
      // Should not contain context/namespace bracket pattern
      expect(result).not.toContain('/default]');
      expect(result).not.toMatch(/\[[\w-]+\/[\w-]+\]/);
    });

    it('should include help text at bottom', () => {
      const sessions: SessionInfo[] = [{
        sessionId: 'abc12345678',
        timestamp: new Date(),
        firstMessage: 'Test',
        messageCount: 1,
        filePath: '/path/to/session.jsonl',
      }];
      
      const result = formatSessionList(sessions);
      expect(result).toContain('/resume N to continue');
      expect(result).toContain('/rename <name>');
    });
  });
});
