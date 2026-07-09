import { vi, afterEach } from 'vitest';
import { BLOCKED_PREFIX } from '../harness.ts';
import { escapeRegExpLiteral } from '../regexp-utils.ts';

export function mockFetch(body: string, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    text: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Call at the top of a test file (or inside a describe) to reset timers and globals after each test. */
export function restoreGlobalsAfterEach(): void {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
}

export function makeAbortError(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

export function mockFetchHangsUntilAbort(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((_url: string, opts?: RequestInit) =>
      new Promise<never>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(makeAbortError()));
      }),
    ),
  );
}

export const BLOCKED_RE = new RegExp(`^${escapeRegExpLiteral(BLOCKED_PREFIX)}`, 'i');
