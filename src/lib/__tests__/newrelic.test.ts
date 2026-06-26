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

  it('converts "-1h" to ISO8601 anchored to nowMs', () => {
    expect(resolveNrqlTime('-1h', NOW)).toBe('2024-06-01T11:00:00.000Z');
  });

  it('converts "-30m" to ISO8601 anchored to nowMs', () => {
    expect(resolveNrqlTime('-30m', NOW)).toBe('2024-06-01T11:30:00.000Z');
  });

  it('converts "-2d" to ISO8601 anchored to nowMs', () => {
    expect(resolveNrqlTime('-2d', NOW)).toBe('2024-05-30T12:00:00.000Z');
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

  it('returns plain HTTP error (no detail) when response body is empty', async () => {
    mockFetch('', 502);
    const result = await runNewRelicQuery(
      { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction SINCE 1 hour ago' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/HTTP 502/);
    expect(result).not.toMatch(/:\s+/);
  });

  it('returns error when "from" time cannot be parsed', async () => {
    mockFetch('{}');
    const result = await runNewRelicQuery(
      { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction', from: '-5y' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/could not parse "from" time/);
    expect(result).toContain('-5y');
  });

  it('appends UNTIL when to is specified and query lacks UNTIL', async () => {
    const fetchMock = mockFetch('{"data":{"actor":{"account":{"nrql":{"results":[]}}}}}');
    await runNewRelicQuery(
      { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction SINCE 1 hour ago', to: '-30m' },
      BASE_CONFIG,
    );
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { query: string };
    expect(body.query).toMatch(/UNTIL '\d{4}-\d{2}-\d{2}T/);
  });

  it('does not double-append LIMIT when query already contains LIMIT', async () => {
    const fetchMock = mockFetch('{"data":{"actor":{"account":{"nrql":{"results":[]}}}}}');
    await runNewRelicQuery(
      { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction SINCE 1 hour ago LIMIT 500' },
      BASE_CONFIG,
    );
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { query: string };
    expect((body.query as string).match(/\bLIMIT\b/g) ?? []).toHaveLength(1);
  });

  it('appends SINCE when from is provided and query lacks SINCE', async () => {
    const fetchMock = mockFetch('{"data":{"actor":{"account":{"nrql":{"results":[]}}}}}');
    await runNewRelicQuery(
      { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction', from: '-1h' },
      BASE_CONFIG,
    );
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { query: string };
    expect(body.query).toMatch(/SINCE '\d{4}-\d{2}-\d{2}T/);
  });

  it('does not double-append SINCE when query already contains it', async () => {
    const fetchMock = mockFetch('{"data":{"actor":{"account":{"nrql":{"results":[]}}}}}');
    await runNewRelicQuery(
      { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction SINCE 1 hour ago', from: '-1h' },
      BASE_CONFIG,
    );
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { query: string };
    expect((body.query as string).match(/\bSINCE\b/g) ?? []).toHaveLength(1);
  });

  it('returns error when to time cannot be parsed in metrics query', async () => {
    const result = await runNewRelicQuery(
      { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction', to: '-5y' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/could not parse "to" time/);
    expect(result).toContain('-5y');
  });

  it('appends UNTIL clause when to is a valid time in metrics query', async () => {
    const fetchMock = mockFetch('{"data":{"actor":{"account":{"nrql":{"results":[]}}}}}');
    await runNewRelicQuery(
      { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction', to: '2024-06-01T12:00:00Z' },
      BASE_CONFIG,
    );
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { query: string };
    expect(body.query).toContain("UNTIL '2024-06-01T12:00:00Z'");
  });

  it('appends LIMIT when limit is specified and query lacks LIMIT', async () => {
    const fetchMock = mockFetch('{"data":{"actor":{"account":{"nrql":{"results":[]}}}}}');
    await runNewRelicQuery(
      { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction', limit: 42 },
      BASE_CONFIG,
    );
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { query: string };
    expect(body.query).toContain('LIMIT 42');
  });

  it('does not double-append UNTIL when query already contains it', async () => {
    const fetchMock = mockFetch('{"data":{"actor":{"account":{"nrql":{"results":[]}}}}}');
    await runNewRelicQuery(
      { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction UNTIL now()', to: '-1h' },
      BASE_CONFIG,
    );
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { query: string };
    expect((body.query as string).match(/\bUNTIL\b/g) ?? []).toHaveLength(1);
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
    expect(body.query).toMatch(/SINCE '\d{4}-\d{2}-\d{2}T/);
  });

  it('returns error for invalid from time', async () => {
    mockFetch('{}');
    const result = await runNewRelicQuery(
      { queryType: 'apm', from: '-5y' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/could not parse "from" time/);
  });

  it('includes UNTIL clause when to is specified', async () => {
    const fetchMock = mockFetch('{"data":{"actor":{"account":{"nrql":{"results":[]}}}}}');
    await runNewRelicQuery({ queryType: 'apm', to: '-30m' }, BASE_CONFIG);
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { query: string };
    expect(body.query).toMatch(/UNTIL '\d{4}-\d{2}-\d{2}T/);
  });

  it('returns error when to time cannot be parsed for apm queries', async () => {
    mockFetch('{}');
    const result = await runNewRelicQuery(
      { queryType: 'apm', to: '-5y' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/could not parse "to" time/);
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

  it('wraps OR filter in parentheses so event=open predicate is not short-circuited', async () => {
    const fetchMock = mockFetch('{"data":{"actor":{"account":{"nrql":{"results":[]}}}}}');

    await runNewRelicQuery(
      { queryType: 'alerts', query: "priority = 'CRITICAL' OR priority = 'HIGH'" },
      BASE_CONFIG,
    );

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { query: string };
    expect(body.query).toContain("AND (priority = 'CRITICAL' OR priority = 'HIGH')");
  });

  it('uses 24 hours ago as default lookback expressed as ISO8601', async () => {
    const fetchMock = mockFetch('{"data":{}}');
    await runNewRelicQuery({ queryType: 'alerts' }, BASE_CONFIG);
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { query: string };
    expect(body.query).toMatch(/SINCE '\d{4}-\d{2}-\d{2}T/);
  });

  it('appends UNTIL clause when to is specified', async () => {
    const fetchMock = mockFetch('{"data":{"actor":{"account":{"nrql":{"results":[]}}}}}');
    await runNewRelicQuery(
      { queryType: 'alerts', to: '2024-06-01T12:00:00Z' },
      BASE_CONFIG,
    );
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { query: string };
    expect(body.query).toContain("UNTIL '2024-06-01T12:00:00Z'");
  });

  it('returns error when from time cannot be parsed in alerts query', async () => {
    const result = await runNewRelicQuery(
      { queryType: 'alerts', from: '-5y' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/could not parse "from" time/);
    expect(result).toContain('-5y');
  });

  it('returns error when to time cannot be parsed in alerts query', async () => {
    const result = await runNewRelicQuery(
      { queryType: 'alerts', to: '-5y' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/could not parse "to" time/);
    expect(result).toContain('-5y');
  });

  it('uses provided from time as SINCE clause in alerts query', async () => {
    const fetchMock = mockFetch('{"data":{"actor":{"account":{"nrql":{"results":[]}}}}}');
    await runNewRelicQuery(
      { queryType: 'alerts', from: '2024-06-01T11:00:00Z' },
      BASE_CONFIG,
    );
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { query: string };
    expect(body.query).toContain("SINCE '2024-06-01T11:00:00Z'");
  });

  it('returns error without body snippet when NerdGraph returns empty body on error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: () => Promise.resolve(''),
    }));
    const result = await runNewRelicQuery(
      { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction SINCE 1 hour ago' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/HTTP 429/);
  });

  it('handles NerdGraph response body read failure gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Unavailable',
      text: () => Promise.reject(new Error('body read failed')),
    }));
    const result = await runNewRelicQuery(
      { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction SINCE 1 hour ago' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/503/);
    expect(result).not.toContain('body read failed');
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

  it('handles non-Error thrown during query (String(err) path)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('some plain string error'));
    const result = await runNewRelicQuery(
      { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction SINCE 1 hour ago' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/New Relic query failed/);
    expect(result).toContain('some plain string error');
  });

  it('handles regular Error thrown during query (err.message path)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await runNewRelicQuery(
      { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction SINCE 1 hour ago' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/New Relic query failed/);
    expect(result).toContain('ECONNREFUSED');
  });

  it('fires the abort timer and returns timeout when request hangs', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, opts: RequestInit) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => {
            const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
            reject(err);
          });
        }),
      ));

      const queryPromise = runNewRelicQuery(
        { queryType: 'metrics', query: 'SELECT count(*) FROM Transaction SINCE 1 hour ago' },
        { ...BASE_CONFIG, timeoutMs: 5_000 },
      );

      await vi.runAllTimersAsync();
      const result = await queryPromise;
      expect(result).toMatch(/timed out/);
      expect(result).toContain('5000ms');
    } finally {
      vi.useRealTimers();
    }
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
    expect(result).toContain('[output truncated');
  });
});

