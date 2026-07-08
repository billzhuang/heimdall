import { describe, it, expect, vi } from 'vitest';
import { runDatadogQuery } from '../datadog.ts';
import { resolveTimeSeconds, resolveTimeISO } from '../time-resolution.ts';
import type { DatadogConfig } from '../datadog.ts';
import { mockFetch, restoreGlobalsAfterEach } from './test-helpers.ts';

const BASE_CONFIG: DatadogConfig = {
  apiKey: 'test-api-key',
  appKey: 'test-app-key',
  site: 'datadoghq.com',
  timeoutMs: 5_000,
};

restoreGlobalsAfterEach();

// ---------------------------------------------------------------------------
// resolveTimeSeconds
// ---------------------------------------------------------------------------

describe('resolveTimeSeconds', () => {
  const NOW = new Date('2024-06-01T12:00:00Z').getTime();

  it('subtracts hours from now for "-Xh" expressions', () => {
    expect(resolveTimeSeconds('-1h', NOW)).toBe(Math.floor((NOW - 3_600_000) / 1_000));
  });

  it('subtracts minutes for "-Xm" expressions', () => {
    expect(resolveTimeSeconds('-30m', NOW)).toBe(Math.floor((NOW - 1_800_000) / 1_000));
  });

  it('subtracts days for "-Xd" expressions', () => {
    expect(resolveTimeSeconds('-2d', NOW)).toBe(Math.floor((NOW - 2 * 86_400_000) / 1_000));
  });

  it('passes through Unix second strings as-is', () => {
    expect(resolveTimeSeconds('1717243200', NOW)).toBe(1717243200);
  });

  it('converts Unix millisecond strings to seconds', () => {
    // 1717243200000 ms = 1717243200 s
    expect(resolveTimeSeconds('1717243200000', NOW)).toBe(1717243200);
  });

  it('parses ISO8601 timestamps to Unix seconds', () => {
    // 2024-06-01T12:00:00Z = 1717243200
    expect(resolveTimeSeconds('2024-06-01T12:00:00Z', NOW)).toBe(1717243200);
  });

  it('returns null for unknown duration units', () => {
    expect(resolveTimeSeconds('-5y', NOW)).toBeNull();
  });

  it('returns null for a completely unparseable non-date string', () => {
    // Exercises the final `return null` branch after Date.parse() returns NaN.
    expect(resolveTimeSeconds('not-a-date', NOW)).toBeNull();
  });

  it('returns null when the computed relative timestamp is not finite (nowMs=Infinity)', () => {
    // nowMs - durationMs = Infinity - 3_600_000 = Infinity → !isFinite → null (line 80)
    expect(resolveTimeSeconds('-1h', Infinity)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveTimeISO
// ---------------------------------------------------------------------------

describe('resolveTimeISO', () => {
  const NOW = new Date('2024-06-01T12:00:00Z').getTime();

  it('converts relative "-1h" to ISO8601', () => {
    const result = resolveTimeISO('-1h', NOW);
    expect(result).toBe('2024-06-01T11:00:00.000Z');
  });

  it('converts Unix second epoch to ISO8601', () => {
    expect(resolveTimeISO('1717243200', NOW)).toBe('2024-06-01T12:00:00.000Z');
  });

  it('passes through valid ISO8601 timestamps unchanged', () => {
    const iso = '2024-06-01T00:00:00Z';
    expect(resolveTimeISO(iso, NOW)).toBe(iso);
  });

  it('returns null for unknown duration units', () => {
    expect(resolveTimeISO('-5y', NOW)).toBeNull();
  });

  it('returns null for a completely unparseable non-date string', () => {
    // Exercises the final `return null` branch after Date.parse() returns NaN.
    expect(resolveTimeISO('not-a-date', NOW)).toBeNull();
  });

  it('returns null when the computed relative timestamp is not finite (nowMs=Infinity)', () => {
    // nowMs - durationMs = Infinity - 3_600_000 = Infinity → !isFinite → null (line 109)
    expect(resolveTimeISO('-1h', Infinity)).toBeNull();
  });

  it('converts 13-digit Unix millisecond epoch to ISO8601 (expr.length > 10 branch)', () => {
    // 1717243200000 ms = 2024-06-01T12:00:00Z; the > 10-digit branch uses the value as ms directly
    expect(resolveTimeISO('1717243200000', NOW)).toBe('2024-06-01T12:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// metrics queries
// ---------------------------------------------------------------------------

describe('runDatadogQuery — metrics', () => {
  it('calls /api/v1/query with GET method and correct parameters', async () => {
    const fetchMock = mockFetch('{"series":[]}');

    await runDatadogQuery(
      { queryType: 'metrics', query: 'avg:kubernetes.cpu.usage.total{*}', from: '-1h' },
      BASE_CONFIG,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/query');
    expect(url).toContain('query=avg%3Akubernetes.cpu.usage.total%7B*%7D');
    expect(url).toContain('from=');
    expect(url).toContain('to=');
    expect(init.method).toBe('GET');
  });

  it('sends DD-API-KEY and DD-APPLICATION-KEY headers', async () => {
    const fetchMock = mockFetch('{}');

    await runDatadogQuery(
      { queryType: 'metrics', query: 'avg:system.cpu.user{*}' },
      BASE_CONFIG,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['DD-API-KEY']).toBe('test-api-key');
    expect(headers['DD-APPLICATION-KEY']).toBe('test-app-key');
  });

  it('returns an error when query is empty', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runDatadogQuery({ queryType: 'metrics', query: '' }, BASE_CONFIG);
    expect(result).toMatch(/error/i);
    expect(result).toMatch(/query/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an error when query is null', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runDatadogQuery({ queryType: 'metrics', query: null }, BASE_CONFIG);
    expect(result).toMatch(/error/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the correct site in the URL', async () => {
    const fetchMock = mockFetch('{}');

    await runDatadogQuery(
      { queryType: 'metrics', query: 'avg:system.cpu.user{*}' },
      { ...BASE_CONFIG, site: 'datadoghq.eu' },
    );

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('api.datadoghq.eu');
  });
});

// ---------------------------------------------------------------------------
// logs queries
// ---------------------------------------------------------------------------

describe('runDatadogQuery — logs', () => {
  it('calls /api/v2/logs/events/search with POST method', async () => {
    const fetchMock = mockFetch('{"data":[],"meta":{"page":{}}}');

    await runDatadogQuery(
      { queryType: 'logs', query: 'service:payments status:error', from: '-1h' },
      BASE_CONFIG,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v2/logs/events/search');
    expect(init.method).toBe('POST');
  });

  it('includes the query in the POST body', async () => {
    const fetchMock = mockFetch('{"data":[]}');

    await runDatadogQuery(
      { queryType: 'logs', query: 'service:checkout error', from: '-30m' },
      BASE_CONFIG,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.filter.query).toBe('service:checkout error');
    expect(body.page.limit).toBe(100);
  });

  it('applies limit from params', async () => {
    const fetchMock = mockFetch('{"data":[]}');

    await runDatadogQuery(
      { queryType: 'logs', query: 'error', limit: 50 },
      BASE_CONFIG,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.page.limit).toBe(50);
  });

  it('clamps limit to 1000', async () => {
    const fetchMock = mockFetch('{"data":[]}');

    await runDatadogQuery(
      { queryType: 'logs', query: 'error', limit: 99_999 },
      BASE_CONFIG,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.page.limit).toBe(1000);
  });

  it('includes parsed indexes in the body', async () => {
    const fetchMock = mockFetch('{"data":[]}');

    await runDatadogQuery(
      { queryType: 'logs', query: 'error', indexes: 'main,security' },
      BASE_CONFIG,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.filter.indexes).toEqual(['main', 'security']);
  });

  it('omits indexes from body when not provided', async () => {
    const fetchMock = mockFetch('{"data":[]}');

    await runDatadogQuery(
      { queryType: 'logs', query: 'error' },
      BASE_CONFIG,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.filter.indexes).toBeUndefined();
  });

  it('omits query from body when not provided (matches all logs)', async () => {
    const fetchMock = mockFetch('{"data":[]}');

    await runDatadogQuery(
      { queryType: 'logs', from: '-1h' },
      BASE_CONFIG,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.filter.query).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// events queries
// ---------------------------------------------------------------------------

describe('runDatadogQuery — events', () => {
  it('calls /api/v2/events with GET method', async () => {
    const fetchMock = mockFetch('{"data":[],"meta":{}}');

    await runDatadogQuery(
      { queryType: 'events', from: '-1h', tags: 'env:prod,source:kubernetes' },
      BASE_CONFIG,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v2/events');
    expect(init.method).toBe('GET');
  });

  it('includes tags as filter[tags] param', async () => {
    const fetchMock = mockFetch('{"data":[]}');

    await runDatadogQuery(
      { queryType: 'events', tags: 'env:prod,source:kubernetes', from: '-1h' },
      BASE_CONFIG,
    );

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
    expect(decoded).toContain('filter[tags]=env:prod,source:kubernetes');
  });

  it('includes free-text query as filter[query] param', async () => {
    const fetchMock = mockFetch('{"data":[]}');

    await runDatadogQuery(
      { queryType: 'events', query: 'deployment', from: '-1h' },
      BASE_CONFIG,
    );

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
    expect(decoded).toContain('filter[query]=deployment');
  });

  it('includes page[limit] for limit enforcement', async () => {
    const fetchMock = mockFetch('{"data":[]}');

    await runDatadogQuery(
      { queryType: 'events', from: '-1h', limit: 25 },
      BASE_CONFIG,
    );

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
    expect(decoded).toContain('page[limit]=25');
  });
});

// ---------------------------------------------------------------------------
// monitors queries
// ---------------------------------------------------------------------------

describe('runDatadogQuery — monitors', () => {
  it('calls /api/v1/monitor with GET method', async () => {
    const fetchMock = mockFetch('[{"id":1,"name":"High CPU"}]');

    await runDatadogQuery(
      { queryType: 'monitors', monitorStatus: 'Alert,Warn' },
      BASE_CONFIG,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/monitor');
    expect(init.method).toBe('GET');
  });

  it('always sets group_states=all in the URL regardless of monitorStatus param', async () => {
    const fetchMock = mockFetch('[]');

    await runDatadogQuery(
      { queryType: 'monitors', monitorStatus: 'Alert,Warn,No Data' },
      BASE_CONFIG,
    );

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
    expect(decoded).toContain('group_states=all');
    expect(decoded).not.toContain('group_states=Alert');
  });

  it('client-side filters monitors by overall_state matching monitorStatus', async () => {
    mockFetch(
      JSON.stringify([
        { id: 1, name: 'Monitor A', overall_state: 'Alert' },
        { id: 2, name: 'Monitor B', overall_state: 'OK' },
        { id: 3, name: 'Monitor C', overall_state: 'Warn' },
      ]),
    );

    const result = await runDatadogQuery(
      { queryType: 'monitors', monitorStatus: 'Alert,Warn' },
      BASE_CONFIG,
    );
    const parsed = JSON.parse(result) as Array<{ id: number }>;
    expect(parsed.map((m) => m.id)).toEqual([1, 3]);
  });

  it('returns all monitors when monitorStatus is not specified', async () => {
    const payload = JSON.stringify([
      { id: 1, overall_state: 'Alert' },
      { id: 2, overall_state: 'OK' },
    ]);
    mockFetch(payload);

    const result = await runDatadogQuery({ queryType: 'monitors' }, BASE_CONFIG);
    expect(result).toBe(payload);
  });

  it('passes monitor name filter as `name` param', async () => {
    const fetchMock = mockFetch('[]');

    await runDatadogQuery(
      { queryType: 'monitors', query: 'High CPU' },
      BASE_CONFIG,
    );

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
    expect(decoded).toContain('name=High CPU');
  });

  it('passes monitor tags filter', async () => {
    const fetchMock = mockFetch('[]');

    await runDatadogQuery(
      { queryType: 'monitors', tags: 'team:sre,env:prod' },
      BASE_CONFIG,
    );

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
    expect(decoded).toContain('monitor_tags=team:sre,env:prod');
  });
});

// ---------------------------------------------------------------------------
// HTTP errors
// ---------------------------------------------------------------------------

describe('runDatadogQuery — HTTP errors', () => {
  const mockFetchTextRejection = () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: () => Promise.reject(new Error('read failed')),
      }),
    );
  };

  it('returns a descriptive message on non-2xx metrics response', async () => {
    mockFetch('{"errors":["Invalid query"]}', 400);

    const result = await runDatadogQuery(
      { queryType: 'metrics', query: 'avg:system.cpu.user{*}' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/400/);
  });

  it('includes a snippet of the error body in the error message', async () => {
    mockFetch('Invalid query expression', 400);

    const result = await runDatadogQuery(
      { queryType: 'metrics', query: 'avg:system.cpu.user{*}' },
      BASE_CONFIG,
    );
    expect(result).toContain('Invalid query expression');
  });

  it('returns a descriptive message on non-2xx logs response', async () => {
    mockFetch('{"errors":["Forbidden"]}', 403);

    const result = await runDatadogQuery({ queryType: 'logs', query: 'error' }, BASE_CONFIG);
    expect(result).toMatch(/403/);
  });

  it('returns a descriptive message on non-2xx events response', async () => {
    mockFetch('Unauthorized', 401);

    const result = await runDatadogQuery({ queryType: 'events', from: '-1h' }, BASE_CONFIG);
    expect(result).toMatch(/401/);
    expect(result).toContain('Unauthorized');
  });

  it('returns a descriptive message on non-2xx monitors response', async () => {
    mockFetch('Forbidden', 403);

    const result = await runDatadogQuery({ queryType: 'monitors' }, BASE_CONFIG);
    expect(result).toMatch(/403/);
    expect(result).toContain('Forbidden');
  });

  it('handles response.text() rejection gracefully on metrics error path', async () => {
    mockFetchTextRejection();

    const result = await runDatadogQuery(
      { queryType: 'metrics', query: 'avg:system.cpu.user{*}' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/503/);
    expect(result).not.toContain('read failed');
  });

  it('handles response.text() rejection gracefully on logs error path', async () => {
    mockFetchTextRejection();

    const result = await runDatadogQuery({ queryType: 'logs', query: 'error' }, BASE_CONFIG);
    expect(result).toMatch(/503/);
  });

  it('handles response.text() rejection gracefully on events error path', async () => {
    mockFetchTextRejection();

    const result = await runDatadogQuery({ queryType: 'events', from: '-1h' }, BASE_CONFIG);
    expect(result).toMatch(/503/);
  });

  it('handles response.text() rejection gracefully on monitors error path', async () => {
    mockFetchTextRejection();

    const result = await runDatadogQuery({ queryType: 'monitors' }, BASE_CONFIG);
    expect(result).toMatch(/503/);
  });
});

// ---------------------------------------------------------------------------
// Network / timeout errors
// ---------------------------------------------------------------------------

describe('runDatadogQuery — timeout', () => {
  it('returns a timeout message on AbortError', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortErr));

    const result = await runDatadogQuery(
      { queryType: 'metrics', query: 'avg:system.cpu.user{*}' },
      { ...BASE_CONFIG, timeoutMs: 100 },
    );
    expect(result).toMatch(/timed out/i);
    expect(result).toContain('100ms');
  });

  it('returns a descriptive message on generic fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await runDatadogQuery(
      { queryType: 'metrics', query: 'avg:system.cpu.user{*}' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/Datadog query failed/i);
    expect(result).toContain('ECONNREFUSED');
  });

  it('returns a clean error on malformed config URL', async () => {
    const result = await runDatadogQuery(
      { queryType: 'metrics', query: 'avg:system.cpu.user{*}' },
      { ...BASE_CONFIG, site: 'not a valid site###' },
    );
    expect(result).toMatch(/Datadog query failed/i);
  });

  it('handles a non-Error thrown by fetch via String(err) (line 356 false branch)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('plain string thrown'));

    const result = await runDatadogQuery(
      { queryType: 'metrics', query: 'avg:system.cpu.user{*}' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/Datadog query failed/i);
    expect(result).toContain('plain string thrown');
  });
});

// ---------------------------------------------------------------------------
// Output truncation
// ---------------------------------------------------------------------------

describe('runDatadogQuery — output truncation', () => {
  it('truncates responses longer than 20 000 characters', async () => {
    mockFetch('x'.repeat(25_000));

    const result = await runDatadogQuery(
      { queryType: 'metrics', query: 'avg:system.cpu.user{*}' },
      BASE_CONFIG,
    );
    expect(result.length).toBeLessThan(25_000);
    expect(result).toContain('[output truncated');
  });

  it('does not truncate responses under the limit', async () => {
    const small = '{"series":[{"metric":"system.cpu.user","pointlist":[]}]}';
    mockFetch(small);

    const result = await runDatadogQuery(
      { queryType: 'metrics', query: 'avg:system.cpu.user{*}' },
      BASE_CONFIG,
    );
    expect(result).toBe(small);
    expect(result).not.toContain('[output truncated');
  });
});

// ---------------------------------------------------------------------------
// Regex redaction
// ---------------------------------------------------------------------------

describe('runDatadogQuery — redaction', () => {
  it('applies regex redaction rules to the response', async () => {
    mockFetch('{"token":"supersecret-abc123","data":[]}');

    const result = await runDatadogQuery(
      { queryType: 'logs', query: 'error' },
      {
        ...BASE_CONFIG,
        regexRedactionRules: [
          { name: 'test-token', re: /supersecret-[a-z0-9]+/g },
        ],
      },
    );
    expect(result).not.toContain('supersecret-abc123');
    expect(result).toContain('[REDACTED:test-token]');
  });
});

// ---------------------------------------------------------------------------
// Missing credentials
// ---------------------------------------------------------------------------

describe('runDatadogQuery — missing credentials', () => {
  it('returns an error when apiKey is missing', async () => {
    const result = await runDatadogQuery(
      { queryType: 'metrics', query: 'avg:system.cpu.user{*}' },
      { ...BASE_CONFIG, apiKey: '' },
    );
    expect(result).toMatch(/api key/i);
    expect(result).toMatch(/not configured/i);
  });

  it('returns an error when appKey is missing', async () => {
    const result = await runDatadogQuery(
      { queryType: 'metrics', query: 'avg:system.cpu.user{*}' },
      { ...BASE_CONFIG, appKey: '' },
    );
    expect(result).toMatch(/application key/i);
    expect(result).toMatch(/not configured/i);
  });
});

// ---------------------------------------------------------------------------
// resolveTimeSeconds — additional branch coverage
// ---------------------------------------------------------------------------

describe('resolveTimeSeconds — non-finite nowMs', () => {
  it('returns null when nowMs is Infinity (non-finite subtraction result)', () => {
    expect(resolveTimeSeconds('-1h', Infinity)).toBeNull();
  });

  it('returns null for plain text that Date.parse cannot parse', () => {
    const NOW = new Date('2024-06-01T12:00:00Z').getTime();
    expect(resolveTimeSeconds('not-a-valid-date', NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveTimeISO — additional branch coverage
// ---------------------------------------------------------------------------

describe('resolveTimeISO — additional branches', () => {
  const NOW = new Date('2024-06-01T12:00:00Z').getTime();

  it('returns null when nowMs is Infinity (non-finite subtraction result)', () => {
    expect(resolveTimeISO('-1h', Infinity)).toBeNull();
  });

  it('converts a 13-digit Unix millisecond epoch string to ISO8601', () => {
    expect(resolveTimeISO('1717243200000', NOW)).toBe('2024-06-01T12:00:00.000Z');
  });

  it('returns null for plain text that Date.parse cannot parse', () => {
    expect(resolveTimeISO('not-a-valid-date', NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// monitors — effectiveLimit with numeric limit param
// ---------------------------------------------------------------------------

describe('runDatadogQuery — monitors effectiveLimit', () => {
  it('uses the provided numeric limit clamped to [1, 1000] in the page_size param', async () => {
    const fetchMock = mockFetch('[]');

    await runDatadogQuery({ queryType: 'monitors', limit: 50 }, BASE_CONFIG);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(decodeURIComponent(url)).toContain('page_size=50');
  });
});

// ---------------------------------------------------------------------------
// catch block — non-Error thrown
// ---------------------------------------------------------------------------

describe('runDatadogQuery — non-Error thrown', () => {
  it('returns a failed message using String(err) when a non-Error value is thrown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('network string error'));

    const result = await runDatadogQuery(
      { queryType: 'metrics', query: 'avg:system.cpu.user{*}' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/Datadog query failed/i);
    expect(result).toContain('network string error');
  });
});

// ---------------------------------------------------------------------------
// Unparseable time expressions
// ---------------------------------------------------------------------------

describe('runDatadogQuery — unparseable time expressions', () => {
  it('returns an error for unparseable "from" time in metrics query', async () => {
    const result = await runDatadogQuery(
      { queryType: 'metrics', query: 'avg:system.cpu.user{*}', from: '-5y' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/could not parse "from" time/i);
    expect(result).toContain('-5y');
  });

  it('returns an error for unparseable "to" time in metrics query', async () => {
    const result = await runDatadogQuery(
      { queryType: 'metrics', query: 'avg:system.cpu.user{*}', to: '-5y' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/could not parse "to" time/i);
    expect(result).toContain('-5y');
  });

  it('returns an error for unparseable "from" time in logs query', async () => {
    const result = await runDatadogQuery(
      { queryType: 'logs', query: 'error', from: '-5y' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/could not parse "from" time/i);
    expect(result).toContain('-5y');
  });

  it('returns an error for unparseable "to" time in logs query', async () => {
    const result = await runDatadogQuery(
      { queryType: 'logs', query: 'error', to: '-5y' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/could not parse "to" time/i);
    expect(result).toContain('-5y');
  });

  it('returns an error for unparseable "from" time in events query', async () => {
    const result = await runDatadogQuery(
      { queryType: 'events', from: '-5y' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/could not parse "from" time/i);
    expect(result).toContain('-5y');
  });

  it('returns an error for unparseable "to" time in events query', async () => {
    const result = await runDatadogQuery(
      { queryType: 'events', to: '-5y' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/could not parse "to" time/i);
    expect(result).toContain('-5y');
  });
});

// ---------------------------------------------------------------------------
// monitors — monitorStatus edge cases
// ---------------------------------------------------------------------------

describe('runDatadogQuery — monitors monitorStatus edge cases', () => {
  it('uses DEFAULT_LIMIT when monitors limit is Infinity (effectiveLimit false branch, line 262)', async () => {
    const fetchMock = mockFetch('[]');

    await runDatadogQuery({ queryType: 'monitors', limit: Infinity }, BASE_CONFIG);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    // DEFAULT_LIMIT is 100 for monitors
    expect(url).toContain('page_size=100');
    expect(url).not.toContain('page_size=Infinity');
  });

  it('uses the provided finite limit clamped to [1, MAX_LIMIT] (effectiveLimit true branch, line 262)', async () => {
    const fetchMock = mockFetch('[]');

    await runDatadogQuery({ queryType: 'monitors', limit: 25 }, BASE_CONFIG);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('page_size=25');
  });

  it('returns raw text when response body is not a JSON array', async () => {
    const payload = '{"status":"ok"}';
    mockFetch(payload);

    const result = await runDatadogQuery(
      { queryType: 'monitors', monitorStatus: 'Alert' },
      BASE_CONFIG,
    );
    expect(result).toBe(payload);
  });

  it('returns raw text when response body is invalid JSON', async () => {
    const payload = 'not json at all';
    mockFetch(payload);

    const result = await runDatadogQuery(
      { queryType: 'monitors', monitorStatus: 'Alert' },
      BASE_CONFIG,
    );
    expect(result).toBe(payload);
  });
});

// ---------------------------------------------------------------------------
// Abort timeout — covers the `() => controller.abort()` setTimeout callback
// ---------------------------------------------------------------------------

describe('runDatadogQuery — abort timeout', () => {
  it('fires the setTimeout abort after timeoutMs and returns a timeout message', async () => {
    vi.useFakeTimers();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, opts: RequestInit) =>
        new Promise<never>((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
          );
        }),
      ),
    );

    const queryPromise = runDatadogQuery(
      { queryType: 'metrics', query: 'avg:system.cpu.user{*}' },
      { ...BASE_CONFIG, timeoutMs: 3_000 },
    );

    await vi.advanceTimersByTimeAsync(3_001);
    const result = await queryPromise;

    expect(result).toMatch(/timed out/i);
    expect(result).toContain('3000ms');
  });
});

// ---------------------------------------------------------------------------
// resolveTimeISO — Unix millisecond epoch (11-13 digits)
// ---------------------------------------------------------------------------

describe('resolveTimeISO — Unix millisecond epoch', () => {
  const NOW = new Date('2024-06-01T12:00:00Z').getTime();

  it('converts 13-digit Unix millisecond epoch to ISO8601', () => {
    // 1717243200000 ms = 2024-06-01T12:00:00.000Z
    expect(resolveTimeISO('1717243200000', NOW)).toBe('2024-06-01T12:00:00.000Z');
  });

  it('converts 11-digit Unix millisecond epoch to ISO8601', () => {
    // 17172432000 ms = approximately 1970-07-18 (large ms value)
    const result = resolveTimeISO('17172432000', NOW);
    expect(result).not.toBeNull();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// effectiveLimit — via monitors query (covers the numeric-limit branches)
// ---------------------------------------------------------------------------

describe('runDatadogQuery — monitors numeric limit', () => {
  it('uses the provided limit when a finite integer is given', async () => {
    const fetchMock = mockFetch('[]');

    await runDatadogQuery({ queryType: 'monitors', limit: 25 }, BASE_CONFIG);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(decodeURIComponent(url)).toContain('page_size=25');
  });

  it('falls back to the default limit when limit is Infinity (non-finite number)', async () => {
    const fetchMock = mockFetch('[]');

    await runDatadogQuery({ queryType: 'monitors', limit: Infinity }, BASE_CONFIG);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(decodeURIComponent(url)).toContain('page_size=100');
  });

  it('falls back to the default limit when limit is NaN', async () => {
    const fetchMock = mockFetch('[]');

    await runDatadogQuery({ queryType: 'monitors', limit: NaN }, BASE_CONFIG);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(decodeURIComponent(url)).toContain('page_size=100');
  });
});

// ---------------------------------------------------------------------------
// catch block — non-Error thrown value (String(err) path)
// ---------------------------------------------------------------------------

describe('runDatadogQuery — non-Error thrown value', () => {
  it('handles a thrown string via String(err) and returns a descriptive message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('plain string error'));

    const result = await runDatadogQuery(
      { queryType: 'metrics', query: 'avg:system.cpu.user{*}' },
      BASE_CONFIG,
    );
    expect(result).toMatch(/Datadog query failed/i);
    expect(result).toContain('plain string error');
  });
});
