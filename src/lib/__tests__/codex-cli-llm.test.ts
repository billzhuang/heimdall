import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node:child_process before importing the module under test.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { callCodexCli, isCodexCliAvailable } from '../codex-cli-llm.ts';

type ExecFileCallback = (err: NodeJS.ErrnoException | null, result: { stdout: string; stderr: string }) => void;

function stubExecFile(
  handler: (cmd: string, args: string[], opts: unknown, cb: ExecFileCallback) => void,
) {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(handler);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('callCodexCli', () => {
  it('calls codex with -q and the prompt', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: 'hello world', stderr: '' }));

    await callCodexCli('test prompt');

    const mock = execFile as unknown as ReturnType<typeof vi.fn>;
    expect(mock).toHaveBeenCalledOnce();
    const [cmd, args] = mock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('codex');
    expect(args).toContain('-q');
    expect(args).toContain('test prompt');
  });

  it('returns trimmed stdout', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: '  answer text  \n', stderr: '' }));
    expect(await callCodexCli('q')).toBe('answer text');
  });

  it('passes --model when model option is provided', async () => {
    stubExecFile((_cmd, args, _opts, cb) => {
      expect(args).toContain('--model');
      expect(args).toContain('o4-mini');
      cb(null, { stdout: 'ok', stderr: '' });
    });
    await callCodexCli('q', { model: 'o4-mini' });
  });

  it('does not include --model when model option is absent', async () => {
    stubExecFile((_cmd, args, _opts, cb) => {
      expect(args).not.toContain('--model');
      cb(null, { stdout: 'ok', stderr: '' });
    });
    await callCodexCli('q');
  });

  it('throws when execFile signals an error', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => {
      const err = Object.assign(new Error('spawn error'), { code: 'ENOENT' });
      cb(err as NodeJS.ErrnoException, { stdout: '', stderr: '' });
    });
    await expect(callCodexCli('q')).rejects.toThrow('spawn error');
  });

  it('throws when codex exits with non-zero code', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => {
      const err = Object.assign(new Error('Command failed'), { code: '1' });
      cb(err as NodeJS.ErrnoException, { stdout: '', stderr: 'auth error' });
    });
    await expect(callCodexCli('q')).rejects.toThrow();
  });

  it('returns empty string when stdout is empty', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: '' }));
    expect(await callCodexCli('q')).toBe('');
  });
});

describe('isCodexCliAvailable', () => {
  it('returns true when codex --version succeeds', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: 'codex 1.0.0', stderr: '' }));
    expect(await isCodexCliAvailable()).toBe(true);
  });

  it('returns false when execFile throws (CLI not found)', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => {
      cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException, { stdout: '', stderr: '' });
    });
    expect(await isCodexCliAvailable()).toBe(false);
  });

  it('calls codex with --version', async () => {
    stubExecFile((_cmd, args, _opts, cb) => {
      expect(args).toEqual(['--version']);
      cb(null, { stdout: 'codex 1.2.3', stderr: '' });
    });
    await isCodexCliAvailable();
    const mock = execFile as unknown as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls[0][0]).toBe('codex');
  });
});
