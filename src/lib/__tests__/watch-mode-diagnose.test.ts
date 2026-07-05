/**
 * Characterization tests for watch-mode's diagnoseEvent, which hand-rolls the
 * same "spawn, collect stdout, kill on timeout, settle once on close/error"
 * wiring that spawn-collect.ts's spawnAndCollect already provides. These pin
 * current behavior ahead of a refactor that delegates to spawnAndCollect with
 * no behavior change.
 *
 * spawn is mocked here, so this file cannot live alongside watch-mode.test.ts
 * (which spawns real `tsx` via spawnSync for its out-of-process CLI checks).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { diagnoseEvent } from '../../watch-mode.ts';

type FakeChildOptions = {
  stdoutData?: string;
  exitCode?: number | null;
  signal?: string | null;
  emitError?: Error;
  hang?: boolean;
};

function fakeChild({
  stdoutData = '',
  exitCode = 0,
  signal = null,
  emitError,
  hang = false,
}: FakeChildOptions = {}) {
  const childEmitter = new EventEmitter();
  const stdout = new EventEmitter();

  if (!hang) {
    setImmediate(() => {
      if (emitError) {
        childEmitter.emit('error', emitError);
      } else {
        if (stdoutData) stdout.emit('data', Buffer.from(stdoutData));
        childEmitter.emit('close', exitCode, signal);
      }
    });
  }

  return {
    pid: 4242,
    stdout,
    stderr: new EventEmitter(),
    kill: () => {},
    on: childEmitter.on.bind(childEmitter),
    once: childEmitter.once.bind(childEmitter),
  } as unknown as ReturnType<typeof spawn>;
}

describe('diagnoseEvent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('resolves with trimmed stdout on a clean exit', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ stdoutData: '  pod is crashlooping  \n' }),
    );
    const result = await diagnoseEvent('why is my pod failing?', 'anthropic/claude-sonnet-4-6');
    expect(result).toBe('pod is crashlooping');
  });

  it('resolves with the captured output even on a non-zero exit code (exit code is never treated as failure)', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ stdoutData: 'partial diagnosis', exitCode: 1 }),
    );
    const result = await diagnoseEvent('p');
    expect(result).toBe('partial diagnosis');
  });

  it('resolves with the captured output even when killed by a signal', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ stdoutData: 'partial diagnosis', exitCode: null, signal: 'SIGKILL' }),
    );
    const result = await diagnoseEvent('p');
    expect(result).toBe('partial diagnosis');
  });

  it('resolves "(no diagnosis)" when stdout is empty on close', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => fakeChild({ stdoutData: '' }));
    const result = await diagnoseEvent('p');
    expect(result).toBe('(no diagnosis)');
  });

  it('resolves "(diagnosis failed: <message>)" when spawn emits an error, never rejecting', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ emitError: new Error('spawn ENOENT') }),
    );
    await expect(diagnoseEvent('p')).resolves.toBe('(diagnosis failed: spawn ENOENT)');
  });

  it('kills the child and resolves "(diagnosis timed out)" after the diagnosis timeout, never rejecting', async () => {
    vi.useFakeTimers();
    const killSpy = vi.fn();
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const child = fakeChild({ hang: true });
      (child as unknown as { kill: typeof killSpy }).kill = killSpy;
      return child;
    });

    const promise = diagnoseEvent('p');
    await vi.advanceTimersByTimeAsync(120_000);

    await expect(promise).resolves.toBe('(diagnosis timed out)');
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
  });

  it('spawns with stdout piped and stderr inherited, and passes the prompt as -p <prompt>', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => fakeChild({ stdoutData: 'ok' }));
    await diagnoseEvent('why is my pod failing?');
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      ['-p', 'why is my pod failing?'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'inherit'] }),
    );
  });

  it('sets HEIMDALL_MODEL on the child env when a model is given, and omits it otherwise', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => fakeChild({ stdoutData: 'ok' }));
    await diagnoseEvent('p', 'anthropic/claude-opus-4-8');
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ env: expect.objectContaining({ HEIMDALL_MODEL: 'anthropic/claude-opus-4-8' }) }),
    );

    // Isolate from any HEIMDALL_MODEL already set in the test runner's own
    // environment, so this assertion holds regardless of where tests run.
    vi.stubEnv('HEIMDALL_MODEL', undefined as unknown as string);
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => fakeChild({ stdoutData: 'ok' }));
    await diagnoseEvent('p');
    const [, , lastOpts] = (spawn as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect((lastOpts as { env: NodeJS.ProcessEnv }).env['HEIMDALL_MODEL']).toBeUndefined();
  });
});
