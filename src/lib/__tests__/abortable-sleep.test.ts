import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { abortableSleep, installShutdownController, type SignalTarget } from '../abortable-sleep.ts';

describe('abortableSleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after the delay when never aborted', async () => {
    const controller = new AbortController();
    let resolved = false;
    const promise = abortableSleep(1000, controller.signal).then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(resolved).toBe(true);
  });

  it('resolves early when the signal aborts mid-sleep', async () => {
    const controller = new AbortController();
    let resolved = false;
    const promise = abortableSleep(10_000, controller.signal).then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(false);

    controller.abort();
    await promise;
    expect(resolved).toBe(true);
  });

  it('resolves immediately if the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    await abortableSleep(10_000, controller.signal);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('does not leak the abort listener once the timer fires naturally', async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const promise = abortableSleep(1000, controller.signal);
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

/** Minimal fake process-signal target for testing without touching real process signals. */
function fakeSignalTarget(): SignalTarget & { emit(event: 'SIGINT' | 'SIGTERM'): void; listenerCount(): number } {
  const listeners = new Map<string, Set<() => void>>();
  return {
    once(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    emit(event) {
      const set = listeners.get(event);
      if (!set) return;
      const copy = Array.from(set);
      set.clear();
      for (const listener of copy) listener();
    },
    listenerCount() {
      let count = 0;
      for (const set of listeners.values()) count += set.size;
      return count;
    },
  };
}

describe('installShutdownController', () => {
  it('aborts the signal when SIGINT fires', () => {
    const target = fakeSignalTarget();
    const { signal, cleanup } = installShutdownController(target);

    expect(signal.aborted).toBe(false);
    target.emit('SIGINT');
    expect(signal.aborted).toBe(true);

    cleanup();
  });

  it('aborts the signal when SIGTERM fires', () => {
    const target = fakeSignalTarget();
    const { signal, cleanup } = installShutdownController(target);

    target.emit('SIGTERM');
    expect(signal.aborted).toBe(true);

    cleanup();
  });

  it('cleanup removes both listeners', () => {
    const target = fakeSignalTarget();
    const { cleanup } = installShutdownController(target);

    expect(target.listenerCount()).toBe(2);
    cleanup();
    expect(target.listenerCount()).toBe(0);
  });
});
