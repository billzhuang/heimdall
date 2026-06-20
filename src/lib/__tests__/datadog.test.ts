import { describe, it, expect, vi, afterEach } from 'vitest';
import { runDatadogQuery, resolveTimeSeconds, resolveTimeISO } from '../datadog.ts';
import type { DatadogConfig } from '../datadog.ts';

const BASE_CONFIG: DatadogConfig = {
  apiKey: 'test-api-key',
  appKey: 'test-app-key',
  site: 'datadoghq.com',
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
});

// ---------------------------------------------------------------------------
// events queries
// ---------------------------------------------------------------------------

describe('runDatadogQuery — events', () => {
  it('calls /api/v1/events with GET method', async () => {
    const fetchMock = mockFetch('{"events":[]}');

    await runDatadogQuery(
      { queryType: 'events', from: '-1h', tags: 'env:prod,source:kubernetes' },
      BASE_CONFIG,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/events');
    expect(init.method).toBe('GET');
  });

  it('includes tags in the URL', async () => {
    const fetchMock = mockFetch('{"events":[]}');

    await runDatadogQuery(
      { queryType: 'events', tags: 'env:prod,source:kubernetes', from: '-1h' },
      BASE_CONFIG,
    );

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('tags=env:prod,source:kubernetes');
  });

  it('includes free-text query as `q` param', async () => {
    const fetchMock = mockFetch('{"events":[]}');

    await runDatadogQuery(
      { queryType: 'events', query: 'deployment', from: '-1h' },
      BASE_CONFIG,
    );

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('q=deployment');
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

  it('passes group_states param for monitorStatus filter', async () => {
    const fetchMock = mockFetch('[]');

    await runDatadogQuery(
      { queryType: 'monitors', monitorStatus: 'Alert,Warn,No Data' },
      BASE_CONFIG,
    );

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
    expect(decoded).toContain('group_states=Alert,Warn,No Data');
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
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('monitor_tags=team:sre,env:prod');
  });
});

// ---------------------------------------------------------------------------
// HTTP errors
// ---------------------------------------------------------------------------

describe('runDatadogQuery — HTTP errors', () => {
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
    expect(result).toContain('[Output truncated');
  });

  it('does not truncate responses under the limit', async () => {
    const small = '{"series":[{"metric":"system.cpu.user","pointlist":[]}]}';
    mockFetch(small);

    const result = await runDatadogQuery(
      { queryType: 'metrics', query: 'avg:system.cpu.user{*}' },
      BASE_CONFIG,
    );
    expect(result).toBe(small);
    expect(result).not.toContain('[Output truncated');
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
