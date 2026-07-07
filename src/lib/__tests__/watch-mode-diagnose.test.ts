/**
 * Characterization tests for diagnoseEvent, pinning its current behavior
 * (clean exit, no-output, spawn error, and timeout branches) ahead of
 * migrating it onto the shared spawnAndCollect pipeline (see spawn-collect.ts).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from 'node:child_process';
import { diagnoseEvent, DIAGNOSIS_TIMEOUT_MS } from '../../watch-mode.ts';

type FakeAgentChildOptions = {
  stdoutData?: string;
  exitCode?: number | null;
  emitError?: Error;
  hang?: boolean;
};

/** The diagnosing agent subprocess, mirroring spawn-collect.test.ts's fakeChild helper. */
function fakeAgentChild({ stdoutData = '', exitCode = 0, emitError, hang = false }: FakeAgentChildOptions = {}) {
  const childEmitter = new EventEmitter();
  const stdout = new EventEmitter();
  const kill = vi.fn();

  if (!hang) {
    setImmediate(() => {
      if (emitError) {
        childEmitter.emit('error', emitError);
      } else {
        if (stdoutData) stdout.emit('data', Buffer.from(stdoutData));
        childEmitter.emit('close', exitCode, null);
      }
    });
  }

  return Object.assign(childEmitter, { stdout, stderr: new EventEmitter(), kill });
}

describe('diagnoseEvent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('resolves with trimmed stdout on a clean exit', async () => {
    vi.mocked(spawn).mockImplementationOnce(
      () => fakeAgentChild({ stdoutData: '  Pod is OOMKilled.  \n' }) as unknown as ReturnType<typeof spawn>,
    );

    await expect(diagnoseEvent('diagnose this')).resolves.toBe('Pod is OOMKilled.');
  });

  it('resolves with "(no diagnosis)" when the agent produces no output', async () => {
    vi.mocked(spawn).mockImplementationOnce(() => fakeAgentChild() as unknown as ReturnType<typeof spawn>);

    await expect(diagnoseEvent('diagnose this')).resolves.toBe('(no diagnosis)');
  });

  it('resolves with "(diagnosis failed: ...)" when the subprocess fails to spawn', async () => {
    vi.mocked(spawn).mockImplementationOnce(
      () => fakeAgentChild({ emitError: new Error('spawn ENOENT') }) as unknown as ReturnType<typeof spawn>,
    );

    await expect(diagnoseEvent('diagnose this')).resolves.toBe('(diagnosis failed: spawn ENOENT)');
  });

  it('resolves with "(diagnosis timed out)" and SIGTERMs the child after DIAGNOSIS_TIMEOUT_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const child = fakeAgentChild({ hang: true });
    vi.mocked(spawn).mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>);

    const resultPromise = diagnoseEvent('diagnose this');
    await vi.advanceTimersByTimeAsync(DIAGNOSIS_TIMEOUT_MS);

    await expect(resultPromise).resolves.toBe('(diagnosis timed out)');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
