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
  createSession: vi.fn(),
  loadSession: vi.fn(),
  updateSession: vi.fn(),
  deleteSession: vi.fn(),
}));

const { promptMock } = vi.hoisted(() => ({ promptMock: vi.fn() }));
vi.mock('@flue/sdk', () => ({
  createFlueClient: vi.fn(() => ({ agents: { prompt: promptMock } })),
}));

import { createSession, loadSession, updateSession, deleteSession } from '../session.ts';
import { createFlueClient } from '@flue/sdk';
import {
  cmdInfo,
  cmdEnd,
  cmdStart,
  cmdPrompt,
  formatSession,
  resolveSessionIdArg,
} from '../../session-mode.ts';
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

describe('cmdStart', () => {
  beforeEach(() => {
    vi.mocked(createSession).mockReturnValue(sampleSession);
    // Isolate from the ambient environment so assertions on the default
    // server URL hold regardless of HEIMDALL_SERVER in the test runner.
    vi.stubEnv('HEIMDALL_SERVER', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('creates a session with no flags, defaulting the server URL', () => {
    cmdStart([]);
    expect(createSession).toHaveBeenCalledWith({ name: undefined, serverUrl: 'http://localhost:3583' });
    expect(stdout.join('')).toContain('Session created:');
    expect(stdout.join('')).toContain(sampleSession.id);
  });

  it('resolves --name <label>', () => {
    cmdStart(['--name', 'prod-incident']);
    expect(createSession).toHaveBeenCalledWith({ name: 'prod-incident', serverUrl: 'http://localhost:3583' });
  });

  it('resolves -n <label> shorthand', () => {
    cmdStart(['-n', 'prod-incident']);
    expect(createSession).toHaveBeenCalledWith({ name: 'prod-incident', serverUrl: 'http://localhost:3583' });
  });

  it('resolves --name=<label>', () => {
    cmdStart(['--name=prod-incident']);
    expect(createSession).toHaveBeenCalledWith({ name: 'prod-incident', serverUrl: 'http://localhost:3583' });
  });

  it('accepts an empty --name= value without dying (current lenient behavior)', () => {
    cmdStart(['--name=']);
    expect(createSession).toHaveBeenCalledWith({ name: '', serverUrl: 'http://localhost:3583' });
  });

  it('dies when --name is missing its value', () => {
    expect(() => cmdStart(['--name'])).toThrow('process.exit(1)');
    expect(stderr.join('')).toContain('--name requires a value');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('resolves --server <url>', () => {
    cmdStart(['--server', 'http://example.com:4000']);
    expect(createSession).toHaveBeenCalledWith({ name: undefined, serverUrl: 'http://example.com:4000' });
  });

  it('resolves --server=<url>', () => {
    cmdStart(['--server=http://example.com:4000']);
    expect(createSession).toHaveBeenCalledWith({ name: undefined, serverUrl: 'http://example.com:4000' });
  });

  it('dies when --server is missing its value', () => {
    expect(() => cmdStart(['--server'])).toThrow('process.exit(1)');
    expect(stderr.join('')).toContain('--server requires a value');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('dies on an invalid --server URL', () => {
    expect(() => cmdStart(['--server', 'not-a-url'])).toThrow('process.exit(1)');
    expect(stderr.join('')).toContain('Invalid server URL "not-a-url"');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('dies on an unknown option', () => {
    expect(() => cmdStart(['--bogus'])).toThrow('process.exit(1)');
    expect(stderr.join('')).toContain('unknown option for session start: --bogus');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('prints help and exits 0 for -h', () => {
    expect(() => cmdStart(['-h'])).toThrow('process.exit(0)');
    expect(stdout.join('')).toContain('Usage:');
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe('cmdPrompt', () => {
  beforeEach(() => {
    vi.mocked(loadSession).mockReturnValue(sampleSession);
    vi.mocked(updateSession).mockImplementation(() => {});
    promptMock.mockReset();
    promptMock.mockResolvedValue({ result: { text: 'crash-looping due to OOMKilled' } });
    vi.mocked(createFlueClient).mockClear();
  });

  it('sends the message to the resolved session and prints the response', async () => {
    await cmdPrompt(['why is my pod crash-looping?', '--session', 'session-123']);
    expect(loadSession).toHaveBeenCalledWith('session-123');
    expect(createFlueClient).toHaveBeenCalledWith({ baseUrl: sampleSession.serverUrl });
    expect(promptMock).toHaveBeenCalledWith('heimdall', sampleSession.id, {
      message: 'why is my pod crash-looping?',
    });
    expect(stdout.join('')).toContain('crash-looping due to OOMKilled');
    expect(updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: sampleSession.id, lastPromptAt: expect.any(String) }),
    );
  });

  it('resolves -s <id> shorthand', async () => {
    await cmdPrompt(['hello', '-s', 'session-123']);
    expect(loadSession).toHaveBeenCalledWith('session-123');
  });

  it('resolves --session=<id> form', async () => {
    await cmdPrompt(['hello', '--session=session-123']);
    expect(loadSession).toHaveBeenCalledWith('session-123');
  });

  it('dies when no message is given', async () => {
    await expect(cmdPrompt(['--session', 'session-123'])).rejects.toThrow('process.exit(1)');
    expect(stderr.join('')).toContain('a message is required');
    expect(loadSession).not.toHaveBeenCalled();
  });

  it('dies when --session is missing', async () => {
    await expect(cmdPrompt(['hello'])).rejects.toThrow('process.exit(1)');
    expect(stderr.join('')).toContain('--session <id> is required');
    expect(loadSession).not.toHaveBeenCalled();
  });

  it('dies when --session is missing its value', async () => {
    await expect(cmdPrompt(['hello', '--session'])).rejects.toThrow('process.exit(1)');
    expect(stderr.join('')).toContain('--session requires a value');
  });

  it('dies with the underlying error when loadSession throws', async () => {
    vi.mocked(loadSession).mockImplementation(() => {
      throw new Error('Session not found: session-123');
    });
    await expect(cmdPrompt(['hello', '--session', 'session-123'])).rejects.toThrow('process.exit(1)');
    expect(stderr.join('')).toContain('Session not found: session-123');
  });

  it('dies on an invalid server URL configured for the session', async () => {
    vi.mocked(loadSession).mockReturnValue({ ...sampleSession, serverUrl: 'not-a-url' });
    await expect(cmdPrompt(['hello', '--session', 'session-123'])).rejects.toThrow('process.exit(1)');
    expect(stderr.join('')).toContain('Invalid server URL "not-a-url"');
  });

  it('dies with a helpful message when the Flue server is unreachable', async () => {
    promptMock.mockRejectedValue(new Error('fetch failed'));
    await expect(cmdPrompt(['hello', '--session', 'session-123'])).rejects.toThrow('process.exit(1)');
    expect(stderr.join('')).toContain('Failed to reach Flue server');
    expect(stderr.join('')).toContain('fetch failed');
  });

  it('warns but does not fail the response when updateSession throws', async () => {
    vi.mocked(updateSession).mockImplementation(() => {
      throw new Error('disk full');
    });
    await cmdPrompt(['hello', '--session', 'session-123']);
    expect(stdout.join('')).toContain('crash-looping due to OOMKilled');
    expect(stderr.join('')).toContain('Warning: failed to persist session metadata: disk full');
  });

  it('dies on an unknown option', async () => {
    await expect(cmdPrompt(['hello', '--session', 'session-123', '--bogus'])).rejects.toThrow(
      'process.exit(1)',
    );
    expect(stderr.join('')).toContain('unknown option for session prompt: --bogus');
  });

  it('prints help and exits 0 for -h', async () => {
    await expect(cmdPrompt(['-h'])).rejects.toThrow('process.exit(0)');
    expect(stdout.join('')).toContain('Usage:');
  });
});
