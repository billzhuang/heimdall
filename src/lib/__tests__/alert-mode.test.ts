import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }));

import { spawn } from 'node:child_process';
import { addKubectlResultIfValid, validateSourceArg, runAgent } from '../../alert-mode.ts';
import { BLOCKED_PREFIX } from '../harness.ts';

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

describe('addKubectlResultIfValid', () => {
  it('appends a formatted entry for a valid non-error result', () => {
    const parts: string[] = [];
    addKubectlResultIfValid(parts, 'kubectl get pods -n prod', 'NAME   READY\npod-1  1/1');
    expect(parts).toEqual(['--- kubectl get pods -n prod ---\nNAME   READY\npod-1  1/1']);
  });

  it('does not append when result is an empty string', () => {
    const parts: string[] = [];
    addKubectlResultIfValid(parts, 'kubectl get pods -n prod', '');
    expect(parts).toHaveLength(0);
  });

  it('does not append when result starts with "Error:"', () => {
    const parts: string[] = [];
    addKubectlResultIfValid(parts, 'kubectl get pods -n prod', 'Error: namespace not found');
    expect(parts).toHaveLength(0);
  });

  it('does not append when result starts with BLOCKED_PREFIX', () => {
    const parts: string[] = [];
    addKubectlResultIfValid(parts, 'kubectl delete pods', `${BLOCKED_PREFIX}delete is not allowed`);
    expect(parts).toHaveLength(0);
  });

  it('appends to existing parts without disturbing them', () => {
    const parts = ['--- existing ---\ndata'];
    addKubectlResultIfValid(parts, 'kubectl get ns', 'default\nprod');
    expect(parts).toEqual([
      '--- existing ---\ndata',
      '--- kubectl get ns ---\ndefault\nprod',
    ]);
  });

  it('skips error and blocked entries and accumulates only valid ones', () => {
    const parts: string[] = [];
    addKubectlResultIfValid(parts, 'label-1', 'output-1');
    addKubectlResultIfValid(parts, 'label-2', 'Error: skip this');
    addKubectlResultIfValid(parts, 'label-3', `${BLOCKED_PREFIX}blocked`);
    addKubectlResultIfValid(parts, 'label-4', 'output-4');
    expect(parts).toEqual([
      '--- label-1 ---\noutput-1',
      '--- label-4 ---\noutput-4',
    ]);
  });
});

describe('validateSourceArg', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['grafana', 'prometheus', 'pagerduty', 'raw'] as const)(
    'returns %s unchanged for a valid source',
    (source) => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      expect(validateSourceArg(source)).toBe(source);
      expect(exitSpy).not.toHaveBeenCalled();
    },
  );

  it('writes an error and exits(1) for an unrecognized value', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    validateSourceArg('datadog');
    expect(stderrSpy).toHaveBeenCalledWith(
      'Error: --source must be grafana, prometheus, pagerduty, or raw\n',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes an error and exits(1) for an empty value', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    validateSourceArg('');
    expect(stderrSpy).toHaveBeenCalledWith(
      'Error: --source must be grafana, prometheus, pagerduty, or raw\n',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('runAgent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('resolves on a clean exit (code 0)', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => fakeChild({ exitCode: 0 }));
    await expect(runAgent('investigate pod x')).resolves.toBeUndefined();
  });

  it('spawns with fully inherited stdio and the prompt as -p arg', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => fakeChild({ exitCode: 0 }));
    await runAgent('investigate pod x');
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      ['-p', 'investigate pod x'],
      expect.objectContaining({ stdio: ['ignore', 'inherit', 'inherit'] }),
    );
  });

  it('sets HEIMDALL_MODEL in the child env when a model is passed', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => fakeChild({ exitCode: 0 }));
    await runAgent('p', 'anthropic/claude-opus-4-8');
    const calls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
    const env = calls[calls.length - 1][2].env;
    expect(env.HEIMDALL_MODEL).toBe('anthropic/claude-opus-4-8');
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

  it('kills the child and rejects on timeout', async () => {
    vi.useFakeTimers();
    const killSpy = vi.fn();
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const child = fakeChild({ hang: true });
      (child as unknown as { kill: typeof killSpy }).kill = killSpy;
      return child;
    });

    const promise = runAgent('p');
    const assertion = expect(promise).rejects.toThrow('alert investigation timed out');
    await vi.advanceTimersByTimeAsync(300_000);
    await assertion;
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
  });
});
