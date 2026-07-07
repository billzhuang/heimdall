import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { parseScheduleArgv, runAgent, resolveTriageSchedule } from '../../schedule-mode.ts';
import type { HeimdallConfig } from '../config.ts';

function makeConfig(triage: Partial<NonNullable<HeimdallConfig['schedule']>['triage']> | undefined): HeimdallConfig {
  return { schedule: triage ? { triage } : undefined } as unknown as HeimdallConfig;
}

// ---------------------------------------------------------------------------
// Fake child process factory for runAgent tests
// ---------------------------------------------------------------------------

type FakeChildOptions = {
  exitCode?: number | null;
  signal?: string | null;
  emitError?: Error;
  hang?: boolean;
};

function fakeChild({ exitCode = 0, signal = null, emitError, hang = false }: FakeChildOptions = {}) {
  const childEmitter = new EventEmitter();

  if (!hang) {
    setImmediate(() => {
      if (emitError) childEmitter.emit('error', emitError);
      else childEmitter.emit('close', exitCode, signal);
    });
  }

  return {
    pid: 4242,
    stdout: undefined,
    stderr: undefined,
    kill: () => {},
    on: childEmitter.on.bind(childEmitter),
    once: childEmitter.once.bind(childEmitter),
  } as unknown as ReturnType<typeof spawn>;
}

describe('runAgent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('resolves on a clean exit (code 0)', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => fakeChild({ exitCode: 0 }));
    await expect(runAgent('run triage')).resolves.toBeUndefined();
  });

  it('spawns with fully inherited stdio and the prompt as -p arg', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => fakeChild({ exitCode: 0 }));
    await runAgent('run triage');
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      ['-p', 'run triage'],
      expect.objectContaining({ stdio: ['ignore', 'inherit', 'inherit'] }),
    );
  });

  it('rejects with a descriptive error on a non-zero exit code', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => fakeChild({ exitCode: 1 }));
    await expect(runAgent('p')).rejects.toThrow('heimdall exited with code 1');
  });

  it('rejects with a descriptive error when killed by a signal', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ exitCode: null, signal: 'SIGKILL' }),
    );
    await expect(runAgent('p')).rejects.toThrow('heimdall killed by signal SIGKILL');
  });

  it('rejects when spawn emits an error event', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ emitError: new Error('spawn ENOENT') }),
    );
    await expect(runAgent('p')).rejects.toThrow('spawn ENOENT');
  });

  it('kills the child with SIGTERM and rejects on timeout', async () => {
    vi.useFakeTimers();
    const killSpy = vi.fn();
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const child = fakeChild({ hang: true });
      (child as unknown as { kill: typeof killSpy }).kill = killSpy;
      return child;
    });

    const promise = runAgent('p');
    const assertion = expect(promise).rejects.toThrow('triage timed out after 5 minutes');
    await vi.advanceTimersByTimeAsync(300_000);
    await assertion;
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
  });

  it('escalates to SIGKILL if the child ignores SIGTERM after a timeout', async () => {
    vi.useFakeTimers();
    const killSpy = vi.fn();
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const child = fakeChild({ hang: true });
      (child as unknown as { kill: typeof killSpy }).kill = killSpy;
      return child;
    });

    const promise = runAgent('p');
    const assertion = expect(promise).rejects.toThrow('triage timed out after 5 minutes');
    await vi.advanceTimersByTimeAsync(300_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(killSpy).toHaveBeenCalledWith('SIGKILL');
  });

  it('rejects immediately without spawning when the signal is already aborted', async () => {
    const callsBefore = (spawn as ReturnType<typeof vi.fn>).mock.calls.length;
    const controller = new AbortController();
    controller.abort();
    await expect(runAgent('p', controller.signal)).rejects.toThrow('Aborted');
    expect((spawn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });

  it('kills the child and rejects when the signal aborts mid-run', async () => {
    const killSpy = vi.fn();
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const child = fakeChild({ hang: true });
      (child as unknown as { kill: typeof killSpy }).kill = killSpy;
      return child;
    });

    const controller = new AbortController();
    const promise = runAgent('p', controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow('Aborted');
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('resolveTriageSchedule', () => {
  it('returns disabled when schedule.triage is absent', () => {
    expect(resolveTriageSchedule(makeConfig(undefined))).toEqual({ ok: false, reason: 'disabled' });
  });

  it('returns disabled when schedule.triage.enabled is false', () => {
    const config = makeConfig({ enabled: false });
    expect(resolveTriageSchedule(config)).toEqual({ ok: false, reason: 'disabled' });
  });

  it('defaults cron to every 6 hours when enabled without an explicit cron', () => {
    const config = makeConfig({ enabled: true });
    expect(resolveTriageSchedule(config)).toEqual({
      ok: true,
      cron: '0 */6 * * *',
      triageOpts: { namespace: undefined, allNamespaces: false },
    });
  });

  it('carries through an explicit cron, namespace, and allNamespaces', () => {
    const config = makeConfig({ enabled: true, cron: '0 0 * * *', namespace: 'prod', allNamespaces: false });
    expect(resolveTriageSchedule(config)).toEqual({
      ok: true,
      cron: '0 0 * * *',
      triageOpts: { namespace: 'prod', allNamespaces: false },
    });
  });

  it('returns invalid-cron with the validation error for a malformed cron', () => {
    const config = makeConfig({ enabled: true, cron: 'not-a-cron' });
    const result = resolveTriageSchedule(config);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'invalid-cron') {
      expect(result.cron).toBe('not-a-cron');
      expect(result.error).toBeTruthy();
    } else {
      throw new Error('expected invalid-cron result');
    }
  });
});

describe('parseScheduleArgv', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns runOnce: false for no args', () => {
    expect(parseScheduleArgv([])).toEqual({ runOnce: false });
  });

  it('sets runOnce: true for --once', () => {
    expect(parseScheduleArgv(['--once'])).toEqual({ runOnce: true });
  });

  it('prints usage and exits 0 for --help/-h', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    parseScheduleArgv(['--help']);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: heimdall schedule [--once]'));
    expect(exitSpy).toHaveBeenCalledWith(0);

    parseScheduleArgv(['-h']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 1 with an error for an unknown option', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    parseScheduleArgv(['--bogus']);
    expect(stderrSpy).toHaveBeenCalledWith('Error: unknown option: --bogus\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
