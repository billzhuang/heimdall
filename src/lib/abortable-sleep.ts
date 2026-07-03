/**
 * Shared abort-aware helpers for the long-running CLI modes (watch, schedule):
 * an interruptible sleep and the SIGINT/SIGTERM → AbortController wiring used
 * to unwind their loops cleanly.
 */

/** Interruptible sleep that resolves early when the abort signal fires. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Minimal process-signal surface needed to wire up shutdown; injectable for tests. */
export interface SignalTarget {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): void;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): void;
}

export interface ShutdownController {
  signal: AbortSignal;
  /** Remove the SIGINT/SIGTERM listeners registered by this controller. */
  cleanup: () => void;
}

/**
 * Register SIGINT/SIGTERM handlers that abort a fresh AbortController, so a
 * long-running loop can watch `signal.aborted` and unwind cleanly.
 * Call `cleanup()` once the loop exits to remove the listeners.
 */
export function installShutdownController(target: SignalTarget = process): ShutdownController {
  const controller = new AbortController();
  const onSignal = () => { controller.abort(); };
  target.once('SIGINT', onSignal);
  target.once('SIGTERM', onSignal);
  return {
    signal: controller.signal,
    cleanup: () => {
      target.removeListener('SIGINT', onSignal);
      target.removeListener('SIGTERM', onSignal);
    },
  };
}
