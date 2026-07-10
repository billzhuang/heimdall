import { describe, it, expect, vi, afterEach } from 'vitest';
import { withTimeout, fetchWithTimeout, postJsonWithTimeout, readErrorDetail, formatHttpErrorMessage, formatQueryError, makeResponseHandler, truncatedDetail } from '../http.ts';
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
// postJsonWithTimeout
// ---------------------------------------------------------------------------

describe('postJsonWithTimeout', () => {
  it('POSTs JSON with Content-Type, body, and an AbortSignal, returns handler result', async () => {
    const mockResponse = { ok: true, status: 200 };
    const fetchMock = vi.fn().mockResolvedValue(mockResponse);
    vi.stubGlobal('fetch', fetchMock);

    const result = await postJsonWithTimeout(
      'http://example.com',
      { hello: 'world' },
      5_000,
      async (res) => res,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { signal: AbortSignal }];
    expect(url).toBe('http://example.com');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init.body).toBe(JSON.stringify({ hello: 'world' }));
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(result).toBe(mockResponse);
  });

  it('merges extraHeaders on top of Content-Type', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await postJsonWithTimeout('http://example.com', {}, 5_000, async (res) => res, {
      Authorization: 'Bearer token',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer token',
    });
  });

  it('replaces the default Content-Type when extraHeaders has a differently-cased content-type', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await postJsonWithTimeout('http://example.com', {}, 5_000, async (res) => res, {
      'content-type': 'application/x-protobuf',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({ 'content-type': 'application/x-protobuf' });
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

      const promise = postJsonWithTimeout('http://slow.example.com', {}, 3_000, async (res) => res);
      const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(3_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts handler body consumption after timeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const abortErr = makeAbortError();
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () =>
          new Promise<string>((_, reject) => {
            // simulate a slow body read that the same timer should abort
            setTimeout(() => reject(abortErr), 1_000);
          }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const promise = postJsonWithTimeout('http://example.com', {}, 500, async (res) => {
        await res.text();
      });
      const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// truncatedDetail
// ---------------------------------------------------------------------------

describe('truncatedDetail', () => {
  it('returns empty string for an empty body', () => {
    expect(truncatedDetail('')).toBe('');
  });

  it('formats a non-empty body as ": <body>"', () => {
    expect(truncatedDetail('not found')).toBe(': not found');
  });

  it('caps the body at 200 characters', () => {
    const long = 'x'.repeat(300);
    expect(truncatedDetail(long)).toBe(`: ${'x'.repeat(200)}`);
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
// formatHttpErrorMessage
// ---------------------------------------------------------------------------

describe('formatHttpErrorMessage', () => {
  it('formats "<label> HTTP <status> <statusText>: <body>" for a non-empty body', async () => {
    const response = {
      status: 404,
      statusText: 'Not Found',
      text: () => Promise.resolve('no such dashboard'),
    } as unknown as Response;
    expect(await formatHttpErrorMessage(response, 'Datadog metrics')).toBe(
      'Datadog metrics HTTP 404 Not Found: no such dashboard',
    );
  });

  it('omits the body suffix when the body is empty', async () => {
    const response = {
      status: 502,
      statusText: 'Bad Gateway',
      text: () => Promise.resolve(''),
    } as unknown as Response;
    expect(await formatHttpErrorMessage(response, 'New Relic NerdGraph')).toBe(
      'New Relic NerdGraph HTTP 502 Bad Gateway',
    );
  });

  it('truncates the body to 200 chars', async () => {
    const long = 'x'.repeat(300);
    const response = {
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve(long),
    } as unknown as Response;
    const message = await formatHttpErrorMessage(response, 'Datadog logs');
    expect(message).toBe(`Datadog logs HTTP 500 Internal Server Error: ${'x'.repeat(200)}`);
  });

  it('swallows response.text() rejections, including AbortError, and returns the bare message', async () => {
    const response = {
      status: 503,
      statusText: 'Service Unavailable',
      text: () => Promise.reject(makeAbortError()),
    } as unknown as Response;
    expect(await formatHttpErrorMessage(response, 'New Relic NerdGraph')).toBe(
      'New Relic NerdGraph HTTP 503 Service Unavailable',
    );
  });
});

// ---------------------------------------------------------------------------
// makeResponseHandler
// ---------------------------------------------------------------------------

describe('makeResponseHandler', () => {
  it('returns a service error string for non-2xx responses', async () => {
    const response = {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: () => Promise.resolve('not found'),
    } as unknown as Response;
    const handler = makeResponseHandler('Prometheus', [], (s) => s);
    expect(await handler(response)).toBe('Prometheus HTTP 404 Not Found: not found');
  });

  it('returns truncated redacted body for 2xx responses', async () => {
    const response = {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve('result data here'),
    } as unknown as Response;
    const handler = makeResponseHandler('Loki', [], (s) => s.slice(0, 6));
    expect(await handler(response)).toBe('result');
  });

  it('applies redaction rules to the success body', async () => {
    const response = {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve('token=secret123'),
    } as unknown as Response;
    const rules = [{ name: 'token', re: /token=[^\s]+/g }];
    const handler = makeResponseHandler('Jaeger', rules, (s) => s);
    expect(await handler(response)).toBe('[REDACTED:token]');
  });

  it('applies redaction rules to the error body', async () => {
    const response = {
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: () => Promise.resolve('key=topsecret'),
    } as unknown as Response;
    const rules = [{ name: 'key', re: /key=[^\s]+/g }];
    const handler = makeResponseHandler('Kubecost', rules, (s) => s);
    expect(await handler(response)).toBe('Kubecost HTTP 403 Forbidden: [REDACTED:key]');
  });

  it('re-throws AbortError from readErrorDetail', async () => {
    const abortErr = makeAbortError();
    const response = {
      ok: false,
      status: 0,
      statusText: '',
      text: () => Promise.reject(abortErr),
    } as unknown as Response;
    const handler = makeResponseHandler('Loki', [], (s) => s);
    await expect(handler(response)).rejects.toMatchObject({ name: 'AbortError' });
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
