/**
 * Direct tests for the makeCliLlm factory in cli-llm.ts.
 *
 * The two CLI adapters (claude-cli-llm.ts, codex-cli-llm.ts) are thin wrappers
 * whose own tests cover the bound binary names. These tests focus on the
 * factory-level behavior that the adapter tests cannot reach:
 *   - The binary name and prompt flag are correctly bound to each factory instance.
 *   - Two independent factories bind to different names/flags.
 *   - Timeout and model options are forwarded correctly.
 *   - DEFAULT_TIMEOUT_MS is used when no timeoutMs is provided.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn() };
});

import { execFile } from 'node:child_process';
import { makeCliLlm } from '../cli-llm.ts';

type ExecFileCb = (err: NodeJS.ErrnoException | null, result: { stdout: string; stderr: string }) => void;

function stubExecFile(handler: (cmd: string, args: string[], opts: unknown, cb: ExecFileCb) => void): void {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(handler);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('makeCliLlm — callCli', () => {
  it('invokes execFile with the bound binary name', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: 'ok', stderr: '' }));
    const { callCli } = makeCliLlm('my-cli', '--prompt');
    await callCli('hello');
    const mock = execFile as unknown as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls[0][0]).toBe('my-cli');
  });

  it('passes [promptFlag, prompt] as the first two argv elements', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: 'result', stderr: '' }));
    const { callCli } = makeCliLlm('my-cli', '--ask');
    await callCli('what is kubernetes?');
    const mock = execFile as unknown as ReturnType<typeof vi.fn>;
    const args: string[] = mock.mock.calls[0][1] as string[];
    expect(args[0]).toBe('--ask');
    expect(args[1]).toBe('what is kubernetes?');
  });

  it('returns trimmed stdout', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: '  answer \n', stderr: '' }));
    const { callCli } = makeCliLlm('my-cli', '-p');
    expect(await callCli('q')).toBe('answer');
  });

  it('returns empty string when stdout is empty', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: '' }));
    const { callCli } = makeCliLlm('my-cli', '-p');
    expect(await callCli('q')).toBe('');
  });

  it('includes --model and the model value when opts.model is set', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: 'ok', stderr: '' }));
    const { callCli } = makeCliLlm('my-cli', '-p');
    await callCli('q', { model: 'my-model-1' });
    const mock = execFile as unknown as ReturnType<typeof vi.fn>;
    const args: string[] = mock.mock.calls[0][1] as string[];
    expect(args).toContain('--model');
    expect(args).toContain('my-model-1');
    expect(args.indexOf('--model') + 1).toBe(args.indexOf('my-model-1'));
  });

  it('does not include --model when opts.model is absent', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: 'ok', stderr: '' }));
    const { callCli } = makeCliLlm('my-cli', '-p');
    await callCli('q');
    const mock = execFile as unknown as ReturnType<typeof vi.fn>;
    const args: string[] = mock.mock.calls[0][1] as string[];
    expect(args).not.toContain('--model');
  });

  it('uses DEFAULT_TIMEOUT_MS (120 000) when timeoutMs is not provided', async () => {
    let capturedOpts: unknown;
    stubExecFile((_cmd, _args, opts, cb) => {
      capturedOpts = opts;
      cb(null, { stdout: 'ok', stderr: '' });
    });
    const { callCli } = makeCliLlm('my-cli', '-p');
    await callCli('q');
    expect((capturedOpts as { timeout: number }).timeout).toBe(120_000);
  });

  it('uses opts.timeoutMs when provided', async () => {
    let capturedOpts: unknown;
    stubExecFile((_cmd, _args, opts, cb) => {
      capturedOpts = opts;
      cb(null, { stdout: 'ok', stderr: '' });
    });
    const { callCli } = makeCliLlm('my-cli', '-p');
    await callCli('q', { timeoutMs: 5_000 });
    expect((capturedOpts as { timeout: number }).timeout).toBe(5_000);
  });

  it('throws when execFile signals an error', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => {
      cb(Object.assign(new Error('spawn failed'), { code: 'ENOENT' }) as NodeJS.ErrnoException, { stdout: '', stderr: '' });
    });
    const { callCli } = makeCliLlm('my-cli', '-p');
    await expect(callCli('q')).rejects.toThrow('spawn failed');
  });
});

describe('makeCliLlm — isCliAvailable', () => {
  it('calls execFile with [--version] for the bound binary', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: 'v1.0.0', stderr: '' }));
    const { isCliAvailable } = makeCliLlm('my-cli', '-p');
    await isCliAvailable();
    const mock = execFile as unknown as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls[0][0]).toBe('my-cli');
    expect(mock.mock.calls[0][1]).toEqual(['--version']);
  });

  it('returns true when --version succeeds', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => cb(null, { stdout: 'my-cli 2.0', stderr: '' }));
    const { isCliAvailable } = makeCliLlm('my-cli', '-p');
    expect(await isCliAvailable()).toBe(true);
  });

  it('returns false when execFile throws (CLI not on PATH)', async () => {
    stubExecFile((_cmd, _args, _opts, cb) => {
      cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException, { stdout: '', stderr: '' });
    });
    const { isCliAvailable } = makeCliLlm('my-cli', '-p');
    expect(await isCliAvailable()).toBe(false);
  });

  it('uses a 5-second timeout for the version check', async () => {
    let capturedOpts: unknown;
    stubExecFile((_cmd, _args, opts, cb) => {
      capturedOpts = opts;
      cb(null, { stdout: 'ok', stderr: '' });
    });
    const { isCliAvailable } = makeCliLlm('my-cli', '-p');
    await isCliAvailable();
    expect((capturedOpts as { timeout: number }).timeout).toBe(5_000);
  });
});

describe('makeCliLlm — factory isolation', () => {
  it('two factories bind to independent binary names', async () => {
    const seenBinaries: string[] = [];
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
        seenBinaries.push(cmd);
        cb(null, { stdout: 'ok', stderr: '' });
      },
    );

    const claudeCli = makeCliLlm('claude', '-p');
    const codexCli = makeCliLlm('codex', '-q');
    await claudeCli.callCli('hello');
    await codexCli.callCli('hello');

    expect(seenBinaries).toEqual(['claude', 'codex']);
  });

  it('two factories bind to independent prompt flags', async () => {
    const seenArgs: string[][] = [];
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: ExecFileCb) => {
        seenArgs.push(args as string[]);
        cb(null, { stdout: 'ok', stderr: '' });
      },
    );

    const claudeCli = makeCliLlm('claude', '-p');
    const codexCli = makeCliLlm('codex', '-q');
    await claudeCli.callCli('hello');
    await codexCli.callCli('hello');

    expect(seenArgs[0][0]).toBe('-p');
    expect(seenArgs[1][0]).toBe('-q');
  });
});
