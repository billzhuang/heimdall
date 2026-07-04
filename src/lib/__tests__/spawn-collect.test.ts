/**
 * Direct unit tests for spawn-collect.ts (previously only covered indirectly
 * via eval-runner.test.ts and serve-mode.test.ts, which exercise it through
 * their own onTimeout/onExit callbacks).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { spawnAndCollect } from '../spawn-collect.ts';

type FakeChildOptions = {
  stdoutData?: string;
  stderrData?: string;
  exitCode?: number | null;
  signal?: string | null;
  emitError?: Error;
  pid?: number;
  hang?: boolean;
};

function fakeChild({
  stdoutData = '',
  stderrData = '',
  exitCode = 0,
  signal = null,
  emitError,
  pid = 4242,
  hang = false,
}: FakeChildOptions = {}) {
  const childEmitter = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  if (!hang) {
    setImmediate(() => {
      if (emitError) {
        childEmitter.emit('error', emitError);
      } else {
        if (stdoutData) stdout.emit('data', Buffer.from(stdoutData));
        if (stderrData) stderr.emit('data', Buffer.from(stderrData));
        childEmitter.emit('close', exitCode, signal);
      }
    });
  }

  return {
    pid,
    stdout,
    stderr,
    kill: () => {},
    on: childEmitter.on.bind(childEmitter),
    once: childEmitter.once.bind(childEmitter),
  } as unknown as ReturnType<typeof spawn>;
}

const onExitDefault = (code: number | null, signal: string | null, stdout: string, stderr: string) => {
  if (code !== null && code !== 0) return new Error(`exited with code ${code}: ${stderr}`);
  if (code === null && signal !== null) return new Error(`killed by signal ${signal}`);
  return null;
};

describe('spawnAndCollect', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves with trimmed stdout on a clean exit', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ stdoutData: '  hello  \n' }),
    );
    const result = await spawnAndCollect('bin', [], {
      env: {},
      timeoutMs: 1000,
      onTimeout: () => new Error('timed out'),
      onExit: onExitDefault,
    });
    expect(result).toBe('hello');
  });

  it('rejects via onExit when the process exits non-zero', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ exitCode: 1, stderrData: 'boom' }),
    );
    await expect(
      spawnAndCollect('bin', [], {
        env: {},
        timeoutMs: 1000,
        onTimeout: () => new Error('timed out'),
        onExit: onExitDefault,
      }),
    ).rejects.toThrow('exited with code 1: boom');
  });

  it('rejects via onExit when killed by a signal', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ exitCode: null, signal: 'SIGKILL' }),
    );
    await expect(
      spawnAndCollect('bin', [], {
        env: {},
        timeoutMs: 1000,
        onTimeout: () => new Error('timed out'),
        onExit: onExitDefault,
      }),
    ).rejects.toThrow('killed by signal SIGKILL');
  });

  it('rejects when spawn emits an error event', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ emitError: new Error('spawn ENOENT') }),
    );
    await expect(
      spawnAndCollect('bin', [], {
        env: {},
        timeoutMs: 1000,
        onTimeout: () => new Error('timed out'),
        onExit: onExitDefault,
      }),
    ).rejects.toThrow('spawn ENOENT');
  });

  it('kills the process group and rejects with onTimeout() when timeoutMs elapses (detached)', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => fakeChild({ hang: true, pid: 4242 }));

    await expect(
      spawnAndCollect('bin', [], {
        env: {},
        timeoutMs: 50,
        detached: true,
        onTimeout: () => new Error('timed out after 50ms'),
        onExit: onExitDefault,
      }),
    ).rejects.toThrow('timed out after 50ms');
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
  });

  it('falls back to a direct kill when the process-group kill throws (detached)', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    let killCount = 0;
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const child = fakeChild({ hang: true, pid: 4242 });
      (child as unknown as { kill: () => void }).kill = () => {
        killCount++;
      };
      return child;
    });

    await expect(
      spawnAndCollect('bin', [], {
        env: {},
        timeoutMs: 50,
        detached: true,
        onTimeout: () => new Error('timed out'),
        onExit: onExitDefault,
      }),
    ).rejects.toThrow('timed out');
    expect(killCount).toBe(1);
  });

  it('kills directly (no process-group kill) when not detached', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    let killCount = 0;
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const child = fakeChild({ hang: true, pid: 4242 });
      (child as unknown as { kill: () => void }).kill = () => {
        killCount++;
      };
      return child;
    });

    await expect(
      spawnAndCollect('bin', [], {
        env: {},
        timeoutMs: 50,
        onTimeout: () => new Error('timed out'),
        onExit: onExitDefault,
      }),
    ).rejects.toThrow('timed out');
    expect(killSpy).not.toHaveBeenCalled();
    expect(killCount).toBe(1);
  });

  it('settles only once when close fires after the timeout has already rejected', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    let closeHandler: ((code: number | null, signal: string | null) => void) | undefined;
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const childEmitter = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      return {
        pid: 4242,
        stdout,
        stderr,
        kill: () => {},
        on: (event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'close') closeHandler = handler as typeof closeHandler;
          return childEmitter.on(event, handler);
        },
        once: childEmitter.once.bind(childEmitter),
      } as unknown as ReturnType<typeof spawn>;
    });

    const promise = spawnAndCollect('bin', [], {
      env: {},
      timeoutMs: 10,
      detached: true,
      onTimeout: () => new Error('timed out'),
      onExit: onExitDefault,
    });

    await expect(promise).rejects.toThrow('timed out');
    expect(() => closeHandler?.(0, null)).not.toThrow();
  });
});
