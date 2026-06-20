import { describe, it, expect, vi, afterEach } from 'vitest';
import { runLokiQuery, resolveTime } from '../loki.ts';
import type { LokiConfig } from '../loki.ts';

const BASE_CONFIG: LokiConfig = { url: 'http://loki:3100', timeoutMs: 5_000 };

function mockFetch(body: string, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Bad Request',
      text: () => Promise.resolve(body),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// resolveTime
// ---------------------------------------------------------------------------

describe('resolveTime', () => {
  const NOW = new Date('2024-06-01T12:00:00Z').getTime();

  it('subtracts hours from now for "-Xh" expressions', () => {
    const result = resolveTime('-1h', NOW);
    expect(result).toBe('2024-06-01T11:00:00.000Z');
  });

  it('subtracts minutes from now for "-Xm" expressions', () => {
    const result = resolveTime('-30m', NOW);
    expect(result).toBe('2024-06-01T11:30:00.000Z');
  });

  it('subtracts days from now for "-Xd" expressions', () => {
    const result = resolveTime('-2d', NOW);
    expect(result).toBe('2024-05-30T12:00:00.000Z');
  });

  it('subtracts seconds from now for "-Xs" expressions', () => {
    const result = resolveTime('-60s', NOW);
    expect(result).toBe('2024-06-01T11:59:00.000Z');
  });

  it('passes through ISO8601 timestamps unchanged', () => {
    const iso = '2024-01-15T08:30:00Z';
    expect(resolveTime(iso, NOW)).toBe(iso);
  });

  it('passes through Unix second strings unchanged', () => {
    const unix = '1717243200';
    expect(resolveTime(unix, NOW)).toBe(unix);
  });

  it('passes through expressions with unknown duration units unchanged', () => {
    expect(resolveTime('-5y', NOW)).toBe('-5y');
  });
});

// ---------------------------------------------------------------------------
// Successful queries
// ---------------------------------------------------------------------------

describe('runLokiQuery — success', () => {
  it('calls /loki/api/v1/query_range with the LogQL query', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"status":"success","data":{"result":[]}}'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await runLokiQuery({ query: '{namespace="prod"} |= "ERROR"' }, BASE_CONFIG);

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = fetchMock.mock.calls[0][0] as string;
    const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
    expect(decoded).toContain('/loki/api/v1/query_range');
    expect(decoded).toContain('{namespace="prod"} |= "ERROR"');
  });

  it('returns the raw JSON response body on success', async () => {
    const payload = '{"status":"success","data":{"resultType":"streams","result":[]}}';
    mockFetch(payload);

    const result = await runLokiQuery({ query: '{app="api"}' }, BASE_CONFIG);
    expect(result).toBe(payload);
  });

  it('defaults start to "-1h" and direction to "backward"', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{}'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await runLokiQuery({ query: '{app="api"}' }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('direction=backward');
    expect(url).toContain('limit=100');
    // start should be present and not equal to now (it's in the past)
    expect(url).toContain('start=');
  });

  it('uses the provided limit', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{}'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await runLokiQuery({ query: '{app="api"}', limit: 500 }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('limit=500');
  });

  it('resolves relative start/end times', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{}'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await runLokiQuery({ query: '{app="api"}', start: '-2h', end: '-30m' }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    // start and end should both be ISO8601 timestamps, not the relative strings
    expect(url).not.toContain('start=-2h');
    expect(url).not.toContain('end=-30m');
    expect(url).toContain('start=');
    expect(url).toContain('end=');
  });

  it('passes ISO8601 start/end through unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{}'),
    });
    vi.stubGlobal('fetch', fetchMock);

    const start = '2024-01-01T00:00:00.000Z';
    await runLokiQuery({ query: '{app="api"}', start }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
    expect(decoded).toContain(start);
  });

  it('strips trailing slash from base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    await runLokiQuery({ query: '{app="api"}' }, { ...BASE_CONFIG, url: 'http://loki:3100/' });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain('//loki/api/v1/query_range');
    expect(url).toContain('http://loki:3100/loki/api/v1/query_range');
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe('runLokiQuery — validation', () => {
  it('returns an error for an empty query', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runLokiQuery({ query: '' }, BASE_CONFIG);
    expect(result).toMatch(/error/i);
    expect(result).toMatch(/query/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an error for a whitespace-only query', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runLokiQuery({ query: '   ' }, BASE_CONFIG);
    expect(result).toMatch(/error/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// HTTP errors
// ---------------------------------------------------------------------------

describe('runLokiQuery — HTTP errors', () => {
  it('returns an error message on non-2xx status', async () => {
    mockFetch('parse error at line 1', 400);

    const result = await runLokiQuery({ query: '{bad' }, BASE_CONFIG);
    expect(result).toMatch(/400/);
  });

  it('includes a snippet of the response body in the error', async () => {
    mockFetch('invalid query expression', 400);

    const result = await runLokiQuery({ query: '{app="api"}' }, BASE_CONFIG);
    expect(result).toContain('invalid query expression');
  });
});

// ---------------------------------------------------------------------------
// Network / timeout errors
// ---------------------------------------------------------------------------

describe('runLokiQuery — malformed URL', () => {
  it('returns a clean error message when config.url is not a valid URL', async () => {
    const result = await runLokiQuery(
      { query: '{app="api"}' },
      { url: 'not-a-valid-url', timeoutMs: 5_000 },
    );
    expect(result).toMatch(/Loki query failed/i);
  });
});

describe('runLokiQuery — network errors', () => {
  it('returns a timeout message on AbortError', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortErr));

    const result = await runLokiQuery({ query: '{app="api"}' }, { ...BASE_CONFIG, timeoutMs: 100 });
    expect(result).toMatch(/timed out/i);
    expect(result).toContain('100ms');
  });

  it('returns a descriptive message on generic fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await runLokiQuery({ query: '{app="api"}' }, BASE_CONFIG);
    expect(result).toMatch(/Loki query failed/i);
    expect(result).toContain('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// Output truncation
// ---------------------------------------------------------------------------

describe('runLokiQuery — output truncation', () => {
  it('truncates responses longer than 20 000 characters', async () => {
    const huge = 'x'.repeat(25_000);
    mockFetch(huge);

    const result = await runLokiQuery({ query: '{app="api"}' }, BASE_CONFIG);
    expect(result.length).toBeLessThan(25_000);
    expect(result).toContain('[Output truncated');
  });

  it('does not truncate responses under the limit', async () => {
    const small = '{"status":"success","data":{"result":[]}}';
    mockFetch(small);

    const result = await runLokiQuery({ query: '{app="api"}' }, BASE_CONFIG);
    expect(result).toBe(small);
    expect(result).not.toContain('[Output truncated');
  });
});
