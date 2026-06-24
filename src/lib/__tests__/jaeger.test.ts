import { describe, it, expect, vi, afterEach } from 'vitest';
import { runJaegerQuery, resolveJaegerTimeUs } from '../jaeger.ts';
import type { JaegerConfig } from '../jaeger.ts';
import { mockFetch, makeAbortError } from './test-helpers.ts';

const BASE_CONFIG: JaegerConfig = { url: 'http://jaeger:16686', timeoutMs: 5_000 };

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// resolveJaegerTimeUs
// ---------------------------------------------------------------------------

describe('resolveJaegerTimeUs', () => {
  const NOW_MS = new Date('2024-06-01T12:00:00Z').getTime();

  it('converts relative "-1h" to microseconds from now', () => {
    const result = resolveJaegerTimeUs('-1h', NOW_MS);
    const expectedMs = NOW_MS - 3_600_000;
    expect(result).toBe(expectedMs * 1_000);
  });

  it('converts relative "-30m" to microseconds', () => {
    const result = resolveJaegerTimeUs('-30m', NOW_MS);
    const expectedMs = NOW_MS - 30 * 60_000;
    expect(result).toBe(expectedMs * 1_000);
  });

  it('converts ISO8601 to microseconds', () => {
    const iso = '2024-06-01T11:00:00.000Z';
    const result = resolveJaegerTimeUs(iso, NOW_MS);
    expect(result).toBe(new Date(iso).getTime() * 1_000);
  });

  it('converts bare Unix second epoch to microseconds', () => {
    // 1717243200 = 2024-06-01T12:00:00Z (10 digits)
    const result = resolveJaegerTimeUs('1717243200', NOW_MS);
    expect(result).toBe(1717243200 * 1_000_000);
  });

  it('converts 13-digit Unix millisecond epoch to microseconds (not seconds)', () => {
    // 1717243200000 = 2024-06-01T12:00:00Z in milliseconds (13 digits)
    // Multiplying by 1_000_000 (treating as seconds) would give year ~56385 — wrong.
    const result = resolveJaegerTimeUs('1717243200000', NOW_MS);
    expect(result).toBe(1717243200000 * 1_000);
    // Sanity-check: result should match the 10-digit seconds version
    expect(result).toBe(1717243200 * 1_000_000);
  });

  it('converts 11-digit Unix millisecond epoch to microseconds', () => {
    // 11-digit ms timestamp, e.g. 10000000000 = 2286-11-20 (still ms range)
    const result = resolveJaegerTimeUs('10000000000', NOW_MS);
    expect(result).toBe(10000000000 * 1_000);
  });

  it('returns null for an unrecognised expression', () => {
    expect(resolveJaegerTimeUs('yesterday', NOW_MS)).toBeNull();
  });

  it('returns null for a malformed relative duration', () => {
    expect(resolveJaegerTimeUs('-5y', NOW_MS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Successful queries
// ---------------------------------------------------------------------------

describe('runJaegerQuery — success', () => {
  it('calls /api/traces with the service name', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"data":[]}'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await runJaegerQuery({ service: 'checkout' }, BASE_CONFIG);

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = fetchMock.mock.calls[0][0] as string;
    const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
    expect(decoded).toContain('/api/traces');
    expect(decoded).toContain('service=checkout');
  });

  it('returns the raw JSON response on success', async () => {
    const payload = '{"data":[{"traceID":"abc123","spans":[]}]}';
    mockFetch(payload);

    const result = await runJaegerQuery({ service: 'payments' }, BASE_CONFIG);
    expect(result).toBe(payload);
  });

  it('includes operation in the query URL when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    await runJaegerQuery({ service: 'api', operation: 'POST /charge' }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
    expect(decoded).toContain('operation=POST /charge');
  });

  it('includes minDuration when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    await runJaegerQuery({ service: 'checkout', minDuration: '500ms' }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('minDuration=500ms');
  });

  it('includes tags when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    await runJaegerQuery({ service: 'orders', tags: 'error=true' }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
    expect(decoded).toContain('tags=error=true');
  });

  it('resolves relative start/end to Unix microseconds in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    await runJaegerQuery({ service: 'api', start: '-1h', end: '-30m' }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('start=');
    expect(url).toContain('end=');
    // Values should be numeric microseconds, not human-readable strings
    expect(url).not.toContain('start=-1h');
    expect(url).not.toContain('end=-30m');
  });

  it('passes ISO8601 start/end as microseconds', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    await runJaegerQuery({ service: 'api', start: '2024-06-01T11:00:00.000Z' }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('start=');
    // 2024-06-01T11:00:00Z in microseconds
    const startMs = new Date('2024-06-01T11:00:00.000Z').getTime();
    expect(url).toContain(`start=${startMs * 1_000}`);
  });

  it('strips trailing slash from base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    await runJaegerQuery({ service: 'api' }, { ...BASE_CONFIG, url: 'http://jaeger:16686/' });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain('//api/traces');
    expect(url).toContain('http://jaeger:16686/api/traces');
  });
});

// ---------------------------------------------------------------------------
// Limit clamping
// ---------------------------------------------------------------------------

describe('runJaegerQuery — limit clamping', () => {
  it('uses default limit of 20 when not specified', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    await runJaegerQuery({ service: 'api' }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('limit=20');
  });

  it('clamps limit to MAX_LIMIT (100) when exceeded', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    await runJaegerQuery({ service: 'api', limit: 999 }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('limit=100');
    expect(url).not.toContain('limit=999');
  });

  it('clamps limit to 1 when zero or negative', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    await runJaegerQuery({ service: 'api', limit: 0 }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('limit=1');
  });

  it('uses DEFAULT_LIMIT when limit is null', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    await runJaegerQuery({ service: 'api', limit: null }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('limit=20');
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe('runJaegerQuery — validation', () => {
  it('returns an error for an empty service name', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runJaegerQuery({ service: '' }, BASE_CONFIG);
    expect(result).toMatch(/error/i);
    expect(result).toMatch(/service/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an error for a whitespace-only service name', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runJaegerQuery({ service: '   ' }, BASE_CONFIG);
    expect(result).toMatch(/error/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// HTTP errors
// ---------------------------------------------------------------------------

describe('runJaegerQuery — HTTP errors', () => {
  it('returns an error message on non-2xx status', async () => {
    mockFetch('service not found', 404);

    const result = await runJaegerQuery({ service: 'unknown' }, BASE_CONFIG);
    expect(result).toMatch(/404/);
  });

  it('includes a snippet of the response body in the error', async () => {
    mockFetch('service "xyz" not found in store', 404);

    const result = await runJaegerQuery({ service: 'xyz' }, BASE_CONFIG);
    expect(result).toContain('service "xyz" not found');
  });
});

// ---------------------------------------------------------------------------
// Network / timeout / malformed URL errors
// ---------------------------------------------------------------------------

describe('runJaegerQuery — network errors', () => {
  it('returns a timeout message on AbortError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(makeAbortError()));

    const result = await runJaegerQuery({ service: 'api' }, { ...BASE_CONFIG, timeoutMs: 100 });
    expect(result).toMatch(/timed out/i);
    expect(result).toContain('100ms');
  });

  it('returns a descriptive message on generic fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await runJaegerQuery({ service: 'api' }, BASE_CONFIG);
    expect(result).toMatch(/Jaeger query failed/i);
    expect(result).toContain('ECONNREFUSED');
  });

  it('returns a clean error when config.url is not a valid URL', async () => {
    const result = await runJaegerQuery(
      { service: 'api' },
      { url: 'not-a-valid-url', timeoutMs: 5_000 },
    );
    expect(result).toMatch(/Jaeger query failed/i);
  });
});

// ---------------------------------------------------------------------------
// Output truncation
// ---------------------------------------------------------------------------

describe('runJaegerQuery — output truncation', () => {
  it('truncates responses longer than 20 000 characters', async () => {
    const huge = 'x'.repeat(25_000);
    mockFetch(huge);

    const result = await runJaegerQuery({ service: 'api' }, BASE_CONFIG);
    expect(result.length).toBeLessThan(25_000);
    expect(result).toContain('[output truncated');
  });

  it('does not truncate responses under the limit', async () => {
    const small = '{"data":[],"total":0,"limit":20,"offset":0}';
    mockFetch(small);

    const result = await runJaegerQuery({ service: 'api' }, BASE_CONFIG);
    expect(result).toBe(small);
    expect(result).not.toContain('[output truncated');
  });
});
