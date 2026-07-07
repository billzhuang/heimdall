import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node:child_process before importing the module under test.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { makeCliLlm, buildCliArgs, buildCliExecOptions } from '../cli-llm.ts';

type ExecFileCallback = (err: NodeJS.ErrnoException | null, result: { stdout: string; stderr: string }) => void;
type ExecFileOpts = { timeout?: number; maxBuffer?: number };

function stubExecFile(
  handler: (cmd: string, args: string[], opts: ExecFileOpts, cb: ExecFileCallback) => void,
) {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(handler);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildCliArgs', () => {
  it('returns [promptFlag, prompt] when no model is given', () => {
    expect(buildCliArgs('-p', 'hello')).toEqual(['-p', 'hello']);
  });

  it('appends --model and its value when opts.model is set', () => {
    expect(buildCliArgs('-p', 'hello', { model: 'foo' })).toEqual(['-p', 'hello', '--model', 'foo']);
  });

  it('ignores timeoutMs (it only affects exec options)', () => {
    expect(buildCliArgs('-p', 'hello', { timeoutMs: 1000 })).toEqual(['-p', 'hello']);
  });
});

describe('buildCliExecOptions', () => {
  it('defaults timeout to 120000ms and maxBuffer to 10MB', () => {
    expect(buildCliExecOptions()).toEqual({ timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
  });

  it('uses opts.timeoutMs when provided', () => {
    expect(buildCliExecOptions({ timeoutMs: 42 })).toEqual({ timeout: 42, maxBuffer: 10 * 1024 * 1024 });
  });
});

describe('makeCliLlm callCli', () => {
  it('invokes the given binary with the prompt flag and prompt, in order', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: 'ok', stderr: '' }));
    const { callCli } = makeCliLlm('mycli', '--ask');

    await callCli('what is up');

    const mock = execFile as unknown as ReturnType<typeof vi.fn>;
    expect(mock).toHaveBeenCalledOnce();
    const [cmd, args] = mock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('mycli');
    expect(args).toEqual(['--ask', 'what is up']);
  });

  it('appends --model and its value only when opts.model is set', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: 'ok', stderr: '' }));
    const { callCli } = makeCliLlm('mycli', '-p');

    await callCli('q', { model: 'some-model' });

    const mock = execFile as unknown as ReturnType<typeof vi.fn>;
    const [, args] = mock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['-p', 'q', '--model', 'some-model']);
  });

  it('omits --model when opts.model is absent', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: 'ok', stderr: '' }));
    const { callCli } = makeCliLlm('mycli', '-p');

    await callCli('q');

    const mock = execFile as unknown as ReturnType<typeof vi.fn>;
    const [, args] = mock.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--model');
  });

  it('defaults the exec timeout to 120000ms', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: 'ok', stderr: '' }));
    const { callCli } = makeCliLlm('mycli', '-p');

    await callCli('q');

    const mock = execFile as unknown as ReturnType<typeof vi.fn>;
    const [, , opts] = mock.mock.calls[0] as [string, string[], ExecFileOpts];
    expect(opts.timeout).toBe(120_000);
  });

  it('uses opts.timeoutMs to override the default exec timeout', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: 'ok', stderr: '' }));
    const { callCli } = makeCliLlm('mycli', '-p');

    await callCli('q', { timeoutMs: 5_000 });

    const mock = execFile as unknown as ReturnType<typeof vi.fn>;
    const [, , opts] = mock.mock.calls[0] as [string, string[], ExecFileOpts];
    expect(opts.timeout).toBe(5_000);
  });

  it('sets a 10MB maxBuffer', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: 'ok', stderr: '' }));
    const { callCli } = makeCliLlm('mycli', '-p');

    await callCli('q');

    const mock = execFile as unknown as ReturnType<typeof vi.fn>;
    const [, , opts] = mock.mock.calls[0] as [string, string[], ExecFileOpts];
    expect(opts.maxBuffer).toBe(10 * 1024 * 1024);
  });

  it('trims stdout', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: '  answer  \n', stderr: '' }));
    const { callCli } = makeCliLlm('mycli', '-p');
    expect(await callCli('q')).toBe('answer');
  });

  it('propagates errors from execFile', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => {
      cb(Object.assign(new Error('boom'), { code: '1' }) as NodeJS.ErrnoException, { stdout: '', stderr: '' });
    });
    const { callCli } = makeCliLlm('mycli', '-p');
    await expect(callCli('q')).rejects.toThrow('boom');
  });

  it('keeps separate factory instances independent (cliName/promptFlag are not shared state)', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: 'ok', stderr: '' }));
    const a = makeCliLlm('cli-a', '-a');
    const b = makeCliLlm('cli-b', '-b');

    await a.callCli('x');
    await b.callCli('y');

    const mock = execFile as unknown as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls[0][0]).toBe('cli-a');
    expect(mock.mock.calls[0][1]).toEqual(['-a', 'x']);
    expect(mock.mock.calls[1][0]).toBe('cli-b');
    expect(mock.mock.calls[1][1]).toEqual(['-b', 'y']);
  });
});

describe('makeCliLlm isCliAvailable', () => {
  it('calls the binary with --version and a 5s timeout', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: 'v1', stderr: '' }));
    const { isCliAvailable } = makeCliLlm('mycli', '-p');

    await isCliAvailable();

    const mock = execFile as unknown as ReturnType<typeof vi.fn>;
    const [cmd, args, opts] = mock.mock.calls[0] as [string, string[], ExecFileOpts];
    expect(cmd).toBe('mycli');
    expect(args).toEqual(['--version']);
    expect(opts.timeout).toBe(5_000);
  });

  it('returns true when the binary responds', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: 'v1', stderr: '' }));
    const { isCliAvailable } = makeCliLlm('mycli', '-p');
    expect(await isCliAvailable()).toBe(true);
  });

  it('returns false without throwing when execFile rejects', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => {
      cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException, { stdout: '', stderr: '' });
    });
    const { isCliAvailable } = makeCliLlm('mycli', '-p');
    expect(await isCliAvailable()).toBe(false);
  });
});
