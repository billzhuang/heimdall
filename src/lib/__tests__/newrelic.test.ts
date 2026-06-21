import { describe, it, expect, vi, afterEach } from 'vitest';
import { runNewRelicQuery, resolveNrqlTime } from '../newrelic.ts';
import type { NewRelicConfig } from '../newrelic.ts';

const BASE_CONFIG: NewRelicConfig = {
  apiKey: 'test-api-key',
  accountId: '1234567',
  timeoutMs: 5_000,
};

function mockFetch(body: string, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    text: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// resolveNrqlTime
// ---------------------------------------------------------------------------

describe('resolveNrqlTime', () => {
  const NOW = new Date('2024-06-01T12:00:00Z').getTime();

  it('converts "-1h" to NRQL seconds-ago literal', () => {
    expect(resolveNrqlTime('-1h', NOW)).toBe('3600 seconds ago');
  });

  it('converts "-30m" to NRQL seconds-ago literal', () => {
    expect(resolveNrqlTime('-30m', NOW)).toBe('1800 seconds ago');
  });

  it('converts "-2d" to NRQL seconds-ago literal', () => {
    expect(resolveNrqlTime('-2d', NOW)).toBe('172800 seconds ago');
  });

  it('converts Unix second epoch to ISO8601', () => {
    expect(resolveNrqlTime('1717243200', NOW)).toBe('2024-06-01T12:00:00.000Z');
  });

  it('passes through ISO8601 timestamps unchanged', () => {
    expect(resolveNrqlTime('2024-06-01T00:00:00Z', NOW)).toBe('2024-06-01T00:00:00Z');
  });

  it('returns null for unknown duration units', () => {
    expect(resolveNrqlTime('-5y', NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// error handling for missing credentials
// ---------------------------------------------------------------------------

describe('runNewRelicQuery — missing credentials', () => {
  it('returns error when apiKey is empty', async () => {
    const result = await runNewRelicQuery(
      { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction' },
      { ...BASE_CONFIG, apiKey: '' },
    );
    expect(result).toMatch(/API key is not configured/);
  });

  it('returns error when accountId is empty', async () => {
    const result = await runNewRelicQuery(
      { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction' },
      { ...BASE_CONFIG, accountId: '' },
    );
    expect(result).toMatch(/account ID is not configured/);
  });
});

// ---------------------------------------------------------------------------
// metrics queries
// ---------------------------------------------------------------------------

describe('runNewRelicQuery — metrics', () => {
  it('returns error when query is missing', async () => {
    mockFetch('{}');
    const result = await runNewRelicQuery({ queryType: 'metrics' }, BASE_CONFIG);
    expect(result).toMatch(/query is required for metrics/);
  });

  it('POSTs to NerdGraph with the NRQL query', async () => {
    const fetchMock = mockFetch('{"data":{"actor":{"account":{"nrql":{"results":[]}}}}}');

    const nrql = 'SELECT average(cpuPercent) FROM SystemSample SINCE 1 hour ago';
    await runNewRelicQuery({ queryType: 'metrics', query: nrql }, BASE_CONFIG);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.newrelic.com/graphql');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body as string) as { query: string };
    expect(body.query).toContain(nrql);
    expect(body.query).toContain(BASE_CONFIG.accountId);
  });

  it('sends the correct authorization header', async () => {
    const fetchMock = mockFetch('{"data":{}}');
    await runNewRelicQuery(
      { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction SINCE 1 hour ago' },
      BASE_CONFIG,
    );
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['Api-Key']).toBe('test-api-key');
  });

  it('returns HTTP error string on non-OK response', async () => {
    mockFetch('invalid syntax', 400);
    const result = await runNewRelicQuery(
      { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction SINCE 1 hour ago' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/HTTP 400/);
  });
});

// ---------------------------------------------------------------------------
// apm queries
// ---------------------------------------------------------------------------

describe('runNewRelicQuery — apm', () => {
  it('constructs a Transaction NRQL query with appName filter', async () => {
    const fetchMock = mockFetch('{"data":{"actor":{"account":{"nrql":{"results":[]}}}}}');

    await runNewRelicQuery(
      { queryType: 'apm', query: "appName = 'payments'", from: '-1h' },
      BASE_CONFIG,
    );

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { query: string };
    expect(body.query).toContain('Transaction');
    expect(body.query).toContain("appName = 'payments'");
    expect(body.query).toContain('3600 seconds ago');
  });

  it('returns error for invalid from time', async () => {
    mockFetch('{}');
    const result = await runNewRelicQuery(
      { queryType: 'apm', from: '-5y' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/could not parse "from" time/);
  });

  it('works without a query filter (returns all apps)', async () => {
    const fetchMock = mockFetch('{"data":{"actor":{"account":{"nrql":{"results":[]}}}}}');

    await runNewRelicQuery({ queryType: 'apm' }, BASE_CONFIG);

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { query: string };
    expect(body.query).toContain('Transaction');
    // No user-supplied WHERE filter clause when query is absent
    expect(body.query).not.toContain('FROM Transaction WHERE');
  });
});

// ---------------------------------------------------------------------------
// alerts queries
// ---------------------------------------------------------------------------

describe('runNewRelicQuery — alerts', () => {
  it('queries NrAiIncident for open violations', async () => {
    const fetchMock = mockFetch('{"data":{"actor":{"account":{"nrql":{"results":[]}}}}}');

    await runNewRelicQuery({ queryType: 'alerts' }, BASE_CONFIG);

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { query: string };
    expect(body.query).toContain('NrAiIncident');
    expect(body.query).toContain("event = 'open'");
  });

  it('appends extra WHERE filter from query param', async () => {
    const fetchMock = mockFetch('{"data":{"actor":{"account":{"nrql":{"results":[]}}}}}');

    await runNewRelicQuery(
      { queryType: 'alerts', query: "priority = 'CRITICAL'" },
      BASE_CONFIG,
    );

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { query: string };
    expect(body.query).toContain("priority = 'CRITICAL'");
  });

  it('uses 24 hours ago as default lookback', async () => {
    const fetchMock = mockFetch('{"data":{}}');
    await runNewRelicQuery({ queryType: 'alerts' }, BASE_CONFIG);
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { query: string };
    expect(body.query).toContain('24 hours ago');
  });
});

// ---------------------------------------------------------------------------
// timeout behaviour
// ---------------------------------------------------------------------------

describe('runNewRelicQuery — timeout', () => {
  it('returns timeout message when fetch is aborted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    const result = await runNewRelicQuery(
      { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction SINCE 1 hour ago' },
      { ...BASE_CONFIG, timeoutMs: 1 },
    );
    expect(result).toMatch(/timed out/);
  });
});

// ---------------------------------------------------------------------------
// output truncation
// ---------------------------------------------------------------------------

describe('runNewRelicQuery — truncation', () => {
  it('truncates responses longer than 20 000 characters', async () => {
    const huge = '{"data":{"results":["' + 'x'.repeat(25_000) + '"]}}';
    mockFetch(huge);
    const result = await runNewRelicQuery(
      { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction SINCE 1 hour ago' },
      BASE_CONFIG,
    );
    expect(result.length).toBeLessThan(25_000);
    expect(result).toContain('[Output truncated');
  });
});
