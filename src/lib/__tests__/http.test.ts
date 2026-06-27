import { describe, it, expect, vi, afterEach } from 'vitest';
import { withTimeout, fetchWithTimeout, handleJsonResponse, readErrorDetail, formatQueryError } from '../http.ts';
import { makeAbortError } from './test-helpers.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------

describe('withTimeout', () => {
  it('calls the operation with an AbortSignal and returns its result', async () => {
    let receivedSignal: AbortSignal | undefined;
    const result = await withTimeout(5_000, async (signal) => {
      receivedSignal = signal;
      return 'done';
    });
    expect(result).toBe('done');
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  it('aborts the signal after timeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const abortErr = makeAbortError();
      const promise = withTimeout(
        3_000,
        (signal) => new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(abortErr));
        }),
      );
      const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(3_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not abort before timeoutMs elapses', async () => {
    vi.useFakeTimers();
    try {
      const promise = withTimeout(
        5_000,
        (signal) => new Promise<string>((resolve) => setTimeout(() => {
          expect(signal.aborted).toBe(false);
          resolve('ok');
        }, 1_000)),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(promise).resolves.toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// fetchWithTimeout
// ---------------------------------------------------------------------------

describe('fetchWithTimeout', () => {
  it('calls fetch with the given URL and an AbortSignal, returns handler result', async () => {
    const mockResponse = { ok: true, status: 200 };
    const fetchMock = vi.fn().mockResolvedValue(mockResponse);
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchWithTimeout('http://example.com', 5_000, async (res) => res);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('http://example.com');
    expect(fetchMock.mock.calls[0][1]).toHaveProperty('signal');
    expect(result).toBe(mockResponse);
  });

  it('aborts and throws AbortError after timeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const abortErr = makeAbortError();
      const fetchMock = vi.fn().mockImplementation(
        (_url: unknown, { signal }: { signal: AbortSignal }) =>
          new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(abortErr));
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const promise = fetchWithTimeout('http://slow.example.com', 3_000, async (res) => res);
      // Attach the rejection handler BEFORE advancing timers to avoid an
      // unhandled-rejection warning from the microtask queue racing the timer.
      const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(3_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not abort before timeoutMs elapses', async () => {
    vi.useFakeTimers();
    try {
      const mockResponse = { ok: true };
      const fetchMock = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(mockResponse), 1_000)),
      );
      vi.stubGlobal('fetch', fetchMock);

      const promise = fetchWithTimeout('http://example.com', 5_000, async (res) => res);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(promise).resolves.toBe(mockResponse);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the timer alive while the handler runs', async () => {
    vi.useFakeTimers();
    try {
      const mockResponse = { ok: true };
      const fetchMock = vi.fn().mockResolvedValue(mockResponse);
      vi.stubGlobal('fetch', fetchMock);

      let handlerAborted = false;
      const promise = fetchWithTimeout(
        'http://example.com',
        500,
        (_res) =>
          new Promise<never>((_, reject) => {
            // simulate slow body read that times out
            setTimeout(() => {
              handlerAborted = true;
              reject(makeAbortError());
            }, 1_000);
          }),
      );
      const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(handlerAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// handleJsonResponse
// ---------------------------------------------------------------------------

describe('handleJsonResponse', () => {
  it('returns body text for a 2xx response', async () => {
    const response = { ok: true, text: () => Promise.resolve('hello') } as unknown as Response;
    expect(await handleJsonResponse(response, 'Test', [], (s) => s)).toBe('hello');
  });

  it('applies truncation to a successful response body', async () => {
    const response = { ok: true, text: () => Promise.resolve('long body') } as unknown as Response;
    expect(await handleJsonResponse(response, 'Test', [], (s) => s.slice(0, 4))).toBe('long');
  });

  it('applies redaction rules to a successful response body', async () => {
    const rules = [{ name: 'key', re: /key=[^\s]+/g }];
    const response = { ok: true, text: () => Promise.resolve('key=secret') } as unknown as Response;
    expect(await handleJsonResponse(response, 'Test', rules, (s) => s)).toBe('[REDACTED:key]');
  });

  it('returns formatted error string for a non-ok response', async () => {
    const response = {
      ok: false, status: 503, statusText: 'Service Unavailable',
      text: () => Promise.resolve('overloaded'),
    } as unknown as Response;
    expect(await handleJsonResponse(response, 'Prometheus', [], (s) => s)).toBe(
      'Prometheus HTTP 503 Service Unavailable: overloaded',
    );
  });

  it('re-throws AbortError from error body read', async () => {
    const abortErr = makeAbortError();
    const response = {
      ok: false, status: 503, statusText: 'Service Unavailable',
      text: () => Promise.reject(abortErr),
    } as unknown as Response;
    await expect(handleJsonResponse(response, 'Test', [], (s) => s)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// ---------------------------------------------------------------------------
// readErrorDetail
// ---------------------------------------------------------------------------

describe('readErrorDetail', () => {
  it('returns empty string when body is empty', async () => {
    const response = { text: () => Promise.resolve('') } as unknown as Response;
    expect(await readErrorDetail(response, [])).toBe('');
  });

  it('returns ": <body>" when body is non-empty and no redaction rules', async () => {
    const response = { text: () => Promise.resolve('not found') } as unknown as Response;
    expect(await readErrorDetail(response, [])).toBe(': not found');
  });

  it('truncates body to 200 chars', async () => {
    const long = 'x'.repeat(300);
    const response = { text: () => Promise.resolve(long) } as unknown as Response;
    const detail = await readErrorDetail(response, []);
    expect(detail).toBe(`: ${'x'.repeat(200)}`);
  });

  it('returns empty string when response.text() rejects with a non-AbortError', async () => {
    const response = { text: () => Promise.reject(new Error('socket hang up')) } as unknown as Response;
    expect(await readErrorDetail(response, [])).toBe('');
  });

  it('re-throws AbortError so the outer catch reports it as a timeout', async () => {
    const abortErr = makeAbortError();
    const response = { text: () => Promise.reject(abortErr) } as unknown as Response;
    await expect(readErrorDetail(response, [])).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('applies redaction rules to the body', async () => {
    const response = { text: () => Promise.resolve('token=secret123') } as unknown as Response;
    const rules = [{ name: 'token', re: /token=[^\s]+/g }];
    expect(await readErrorDetail(response, rules)).toBe(': [REDACTED:token]');
  });
});

// ---------------------------------------------------------------------------
// formatQueryError
// ---------------------------------------------------------------------------

describe('formatQueryError', () => {
  it('returns timeout message for AbortError', () => {
    expect(formatQueryError(makeAbortError(), 'Loki', 5_000, [])).toBe(
      'Loki query timed out after 5000ms.',
    );
  });

  it('returns failed message for a generic Error', () => {
    expect(
      formatQueryError(new Error('connection refused'), 'Prometheus', 3_000, []),
    ).toBe('Prometheus query failed: connection refused');
  });

  it('returns failed message for a non-Error thrown value', () => {
    expect(formatQueryError('something went wrong', 'Kubecost', 1_000, [])).toBe(
      'Kubecost query failed: something went wrong',
    );
  });

  it('applies redaction rules to the error message', () => {
    const rules = [{ name: 'key', re: /key=[^\s]+/g }];
    expect(
      formatQueryError(new Error('key=supersecret'), 'Jaeger', 2_000, rules),
    ).toBe('Jaeger query failed: [REDACTED:key]');
  });
});
