/**
 * Unit tests for session-mode's `info`/`end` subcommands and their shared
 * session-id resolution logic.
 *
 * loadSession/deleteSession are mocked so no real session files are touched.
 * process.exit is stubbed to throw so `die()` short-circuits like the real
 * exit would, without killing the test process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../session.ts', () => ({
  loadSession: vi.fn(),
  deleteSession: vi.fn(),
}));

import { loadSession, deleteSession } from '../session.ts';
import { cmdInfo, cmdEnd, formatSession, resolveSessionIdArg } from '../../session-mode.ts';
import type { SessionRecord } from '../session.ts';

const sampleSession: SessionRecord = {
  id: 'session-123',
  name: 'prod-incident',
  serverUrl: 'http://localhost:3583',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastPromptAt: null,
};

let stdout: string[];
let stderr: string[];

beforeEach(() => {
  vi.clearAllMocks();
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatSession', () => {
  it('renders id, name, server, created and last-prompt fields', () => {
    expect(formatSession(sampleSession)).toContain('session-123');
    expect(formatSession(sampleSession)).toContain('prod-incident');
    expect(formatSession(sampleSession)).toContain('no prompts yet');
  });
});

describe('resolveSessionIdArg', () => {
  it('returns undefined for no args', () => {
    expect(resolveSessionIdArg([])).toBeUndefined();
  });

  it('resolves a bare positional arg', () => {
    expect(resolveSessionIdArg(['abc123'])).toBe('abc123');
  });

  it('resolves --session <id>', () => {
    expect(resolveSessionIdArg(['--session', 'abc123'])).toBe('abc123');
  });

  it('resolves -s <id>', () => {
    expect(resolveSessionIdArg(['-s', 'abc123'])).toBe('abc123');
  });

  it('resolves --session=<id>', () => {
    expect(resolveSessionIdArg(['--session=abc123'])).toBe('abc123');
  });

  it('prefers a later --session flag over an earlier positional', () => {
    expect(resolveSessionIdArg(['ignored', '--session', 'abc123'])).toBe('abc123');
  });

  it('takes the last occurrence when --session is repeated', () => {
    expect(resolveSessionIdArg(['--session', 'first', '--session', 'second'])).toBe('second');
  });
});

describe('cmdInfo', () => {
  it('resolves a positional session id and prints its details', () => {
    vi.mocked(loadSession).mockReturnValue(sampleSession);
    cmdInfo(['session-123']);
    expect(loadSession).toHaveBeenCalledWith('session-123');
    expect(stdout.join('')).toContain('session-123');
  });

  it('resolves --session <id> form', () => {
    vi.mocked(loadSession).mockReturnValue(sampleSession);
    cmdInfo(['--session', 'session-123']);
    expect(loadSession).toHaveBeenCalledWith('session-123');
  });

  it('resolves -s <id> shorthand', () => {
    vi.mocked(loadSession).mockReturnValue(sampleSession);
    cmdInfo(['-s', 'session-123']);
    expect(loadSession).toHaveBeenCalledWith('session-123');
  });

  it('resolves --session=<id> form', () => {
    vi.mocked(loadSession).mockReturnValue(sampleSession);
    cmdInfo(['--session=session-123']);
    expect(loadSession).toHaveBeenCalledWith('session-123');
  });

  it('prefers an explicit --session flag over an earlier positional', () => {
    vi.mocked(loadSession).mockReturnValue(sampleSession);
    cmdInfo(['ignored-positional', '--session', 'session-123']);
    expect(loadSession).toHaveBeenCalledWith('session-123');
  });

  it('dies when no session id can be resolved', () => {
    expect(() => cmdInfo([])).toThrow('process.exit(1)');
    expect(stderr.join('')).toContain('session id is required');
    expect(loadSession).not.toHaveBeenCalled();
  });

  it('dies with the underlying error when loadSession throws', () => {
    vi.mocked(loadSession).mockImplementation(() => {
      throw new Error('Session not found: session-123');
    });
    expect(() => cmdInfo(['session-123'])).toThrow('process.exit(1)');
    expect(stderr.join('')).toContain('Session not found: session-123');
  });
});

describe('cmdEnd', () => {
  it('resolves a positional session id and deletes it', () => {
    cmdEnd(['session-123']);
    expect(deleteSession).toHaveBeenCalledWith('session-123');
    expect(stdout.join('')).toContain('Session session-123 ended.');
  });

  it('resolves --session <id> form', () => {
    cmdEnd(['--session', 'session-123']);
    expect(deleteSession).toHaveBeenCalledWith('session-123');
  });

  it('resolves -s <id> shorthand', () => {
    cmdEnd(['-s', 'session-123']);
    expect(deleteSession).toHaveBeenCalledWith('session-123');
  });

  it('resolves --session=<id> form', () => {
    cmdEnd(['--session=session-123']);
    expect(deleteSession).toHaveBeenCalledWith('session-123');
  });

  it('dies when no session id can be resolved', () => {
    expect(() => cmdEnd([])).toThrow('process.exit(1)');
    expect(stderr.join('')).toContain('session id is required');
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('dies with the underlying error when deleteSession throws', () => {
    vi.mocked(deleteSession).mockImplementation(() => {
      throw new Error('Session not found: session-123');
    });
    expect(() => cmdEnd(['session-123'])).toThrow('process.exit(1)');
    expect(stderr.join('')).toContain('Session not found: session-123');
  });
});
