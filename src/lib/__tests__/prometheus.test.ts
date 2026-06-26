import { describe, it, expect, vi, afterEach } from 'vitest';
import { runPrometheusQuery } from '../prometheus.ts';
import type { PrometheusConfig } from '../prometheus.ts';
import { mockFetch, makeAbortError } from './test-helpers.ts';

const BASE_CONFIG: PrometheusConfig = { url: 'http://prometheus:9090', timeoutMs: 5_000 };

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Instant queries
// ---------------------------------------------------------------------------

describe('runPrometheusQuery — instant', () => {
  it('calls /api/v1/query with the PromQL expression', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"status":"success","data":{}}'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await runPrometheusQuery('instant', { query: 'up' }, BASE_CONFIG);

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/query');
    expect(url).toContain('query=up');
  });

  it('appends the time parameter when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{}'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await runPrometheusQuery('instant', { query: 'up', time: '2024-01-01T00:00:00Z' }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('time=2024-01-01T00%3A00%3A00Z');
  });

  it('omits the time parameter when not provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{}'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await runPrometheusQuery('instant', { query: 'up' }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain('time=');
  });

  it('returns the raw JSON response body on success', async () => {
    const payload = '{"status":"success","data":{"resultType":"vector","result":[]}}';
    mockFetch(payload);

    const result = await runPrometheusQuery('instant', { query: 'up' }, BASE_CONFIG);
    expect(result).toBe(payload);
  });

  it('strips trailing slash from the base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    await runPrometheusQuery('instant', { query: 'up' }, { ...BASE_CONFIG, url: 'http://prometheus:9090/' });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain('//api/v1/query');
    expect(url).toContain('http://prometheus:9090/api/v1/query');
  });
});

// ---------------------------------------------------------------------------
// Range queries
// ---------------------------------------------------------------------------

describe('runPrometheusQuery — range', () => {
  it('calls /api/v1/query_range with start, end, step', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    await runPrometheusQuery(
      'range',
      { query: 'rate(http_requests_total[5m])', start: '2024-01-01T00:00:00Z', end: '2024-01-01T01:00:00Z', step: '1m' },
      BASE_CONFIG,
    );

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/query_range');
    expect(url).toContain('step=1m');
    expect(url).toContain('start=');
    expect(url).toContain('end=');
  });

  it('returns an error when start is missing', async () => {
    const result = await runPrometheusQuery(
      'range',
      { query: 'up', end: '2024-01-01T01:00:00Z', step: '1m' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/start/i);
    expect(result).toMatch(/error/i);
  });

  it('returns an error when end is missing', async () => {
    const result = await runPrometheusQuery(
      'range',
      { query: 'up', start: '2024-01-01T00:00:00Z', step: '1m' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/end/i);
    expect(result).toMatch(/error/i);
  });

  it('returns an error when step is missing', async () => {
    const result = await runPrometheusQuery(
      'range',
      { query: 'up', start: '2024-01-01T00:00:00Z', end: '2024-01-01T01:00:00Z' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/step/i);
    expect(result).toMatch(/error/i);
  });

  it('does not call fetch when range params are missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await runPrometheusQuery('range', { query: 'up' }, BASE_CONFIG);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// HTTP errors
// ---------------------------------------------------------------------------

describe('runPrometheusQuery — HTTP errors', () => {
  it('returns an error message on non-2xx HTTP status', async () => {
    mockFetch('invalid PromQL expression', 400);
    const result = await runPrometheusQuery('instant', { query: 'invalid[[[' }, BASE_CONFIG);
    expect(result).toMatch(/400/);
  });

  it('includes a snippet of the response body in the error', async () => {
    mockFetch('bad request body', 400);
    const result = await runPrometheusQuery('instant', { query: 'up' }, BASE_CONFIG);
    expect(result).toContain('bad request body');
  });

  it('omits the body detail when the error response has an empty body', async () => {
    mockFetch('', 400);
    const result = await runPrometheusQuery('instant', { query: 'up' }, BASE_CONFIG);
    expect(result).toMatch(/Prometheus HTTP 400/);
    expect(result).not.toContain(':');
  });
});

// ---------------------------------------------------------------------------
// Network / timeout errors
// ---------------------------------------------------------------------------

describe('runPrometheusQuery — malformed URL', () => {
  it('returns a clean error message when config.url is not a valid URL', async () => {
    const result = await runPrometheusQuery(
      'instant',
      { query: 'up' },
      { url: 'not-a-valid-url', timeoutMs: 5_000 },
    );
    expect(result).toMatch(/Prometheus query failed/i);
  });
});

describe('runPrometheusQuery — network errors', () => {
  it('returns a timeout message on AbortError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(makeAbortError()));

    const result = await runPrometheusQuery('instant', { query: 'up' }, { ...BASE_CONFIG, timeoutMs: 100 });
    expect(result).toMatch(/timed out/i);
    expect(result).toContain('100ms');
  });

  it('returns a descriptive message on generic fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await runPrometheusQuery('instant', { query: 'up' }, BASE_CONFIG);
    expect(result).toMatch(/Prometheus query failed/i);
    expect(result).toContain('ECONNREFUSED');
  });

  it('uses String(err) when the thrown value is not an Error instance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('plain string error'));

    const result = await runPrometheusQuery('instant', { query: 'up' }, BASE_CONFIG);
    expect(result).toMatch(/Prometheus query failed/i);
    expect(result).toContain('plain string error');
  });
});

// ---------------------------------------------------------------------------
// Output truncation
// ---------------------------------------------------------------------------

describe('runPrometheusQuery — output truncation', () => {
  it('truncates responses longer than 20 000 characters', async () => {
    const huge = 'x'.repeat(25_000);
    mockFetch(huge);

    const result = await runPrometheusQuery('instant', { query: 'up' }, BASE_CONFIG);
    expect(result.length).toBeLessThan(25_000);
    expect(result).toContain('[output truncated');
  });

  it('does not truncate responses under the limit', async () => {
    const small = '{"status":"success"}';
    mockFetch(small);

    const result = await runPrometheusQuery('instant', { query: 'up' }, BASE_CONFIG);
    expect(result).toBe(small);
    expect(result).not.toContain('[output truncated');
  });
});
