import { describe, it, expect, vi } from 'vitest';
import { runLokiQuery, resolveTime, validateNamespaceLockdown } from '../loki.ts';
import type { LokiConfig } from '../loki.ts';
import { mockFetch, makeAbortError, mockFetchHangsUntilAbort, restoreGlobalsAfterEach } from './test-helpers.ts';

const BASE_CONFIG: LokiConfig = { url: 'http://loki:3100', timeoutMs: 5_000 };

restoreGlobalsAfterEach();

// ---------------------------------------------------------------------------
// resolveTime
// ---------------------------------------------------------------------------

describe('resolveTime', () => {
  const NOW = new Date('2024-06-01T12:00:00Z').getTime();

  it('subtracts hours from now for "-Xh" expressions', () => {
    expect(resolveTime('-1h', NOW)).toBe('2024-06-01T11:00:00.000Z');
  });

  it('subtracts minutes from now for "-Xm" expressions', () => {
    expect(resolveTime('-30m', NOW)).toBe('2024-06-01T11:30:00.000Z');
  });

  it('subtracts days from now for "-Xd" expressions', () => {
    expect(resolveTime('-2d', NOW)).toBe('2024-05-30T12:00:00.000Z');
  });

  it('subtracts seconds from now for "-Xs" expressions', () => {
    expect(resolveTime('-60s', NOW)).toBe('2024-06-01T11:59:00.000Z');
  });

  it('passes through ISO8601 timestamps unchanged', () => {
    const iso = '2024-01-15T08:30:00Z';
    expect(resolveTime(iso, NOW)).toBe(iso);
  });

  it('converts Unix second strings to ISO8601 (Loki uses nanoseconds for bare integers)', () => {
    // 1717243200 = 2024-06-01T12:00:00Z
    expect(resolveTime('1717243200', NOW)).toBe('2024-06-01T12:00:00.000Z');
  });

  it('converts a short Unix second string (e.g. 10 digits) to ISO8601', () => {
    // 0 = epoch
    expect(resolveTime('0', NOW)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('passes through expressions with unknown duration units unchanged', () => {
    expect(resolveTime('-5y', NOW)).toBe('-5y');
  });

  it('returns the original expression for an out-of-range relative duration (no throw)', () => {
    const hugeExpr = '-999999999999d';
    const result = resolveTime(hugeExpr, NOW);
    // Should not throw; returns expr unchanged when Date is out of range
    expect(typeof result).toBe('string');
  });

  it('returns the original expression when the computed timestamp is not finite (overflow to Infinity)', () => {
    // A 401-digit number overflows parseFloat to Infinity, making durationMs=Infinity
    // and ts = NOW - Infinity = -Infinity, triggering the !Number.isFinite(ts) guard.
    const hugeNum = '1' + '0'.repeat(400);
    const result = resolveTime(`-${hugeNum}d`, NOW);
    expect(result).toBe(`-${hugeNum}d`);
  });
});

// ---------------------------------------------------------------------------
// validateNamespaceLockdown
// ---------------------------------------------------------------------------

describe('validateNamespaceLockdown', () => {
  it('accepts queries with exact namespace= selector', () => {
    expect(validateNamespaceLockdown('{namespace="prod", app="api"} |= "ERROR"', 'prod')).toBe(true);
  });

  it('accepts queries with exact namespace=~ selector', () => {
    expect(validateNamespaceLockdown('{namespace=~"prod", app="api"}', 'prod')).toBe(true);
  });

  it('rejects queries with a different namespace', () => {
    expect(validateNamespaceLockdown('{namespace="staging"} |= "error"', 'prod')).toBe(false);
  });

  it('rejects queries with no namespace selector', () => {
    expect(validateNamespaceLockdown('{app="api"} |= "error"', 'prod')).toBe(false);
  });

  it('rejects wildcard namespace selectors that match other namespaces', () => {
    expect(validateNamespaceLockdown('{namespace=~".+"} |= "error"', 'prod')).toBe(false);
  });

  it('handles namespace values with special regex characters safely', () => {
    expect(validateNamespaceLockdown('{namespace="my.ns"} |= "error"', 'my.ns')).toBe(true);
    expect(validateNamespaceLockdown('{namespace="myzns"} |= "error"', 'my.ns')).toBe(false);
  });

  it('rejects a mismatched selector even when a raw-string line filter contains the locked namespace text', () => {
    expect(
      validateNamespaceLockdown('{namespace="evil"} |= `namespace="prod"`', 'prod'),
    ).toBe(false);
  });

  it('rejects a mismatched selector even when the locked namespace text appears outside the selector', () => {
    expect(
      validateNamespaceLockdown('{app="api"} |= "namespace=\\"prod\\""', 'prod'),
    ).toBe(false);
  });

  it('rejects a query with no selector at all', () => {
    expect(validateNamespaceLockdown('namespace="prod"', 'prod')).toBe(false);
  });

  it('ignores braces inside quoted regex values when locating the selector boundary', () => {
    expect(
      validateNamespaceLockdown('{namespace=~"prod-[0-9]{3}"} |= "error"', 'prod-[0-9]{3}'),
    ).toBe(true);
  });

  it('rejects a bypass where a backtick-quoted matcher value spoofs the locked namespace text', () => {
    // The real selector targets "evil"; the decoy `namespace="prod"` text lives inside a
    // backtick raw-string label value (app=~`...`) and inside a backtick line filter.
    const query = '{namespace="evil", app=~`foo"bar`} |= `" namespace="prod" }`';
    expect(validateNamespaceLockdown(query, 'prod')).toBe(false);
    expect(validateNamespaceLockdown(query, 'evil')).toBe(true);
  });

  it('does not block a legitimate query whose backtick-quoted value contains a brace', () => {
    const query = '{namespace="prod", app=~`foo\\{.*`}';
    expect(validateNamespaceLockdown(query, 'prod')).toBe(true);
  });

  it('accepts a backtick-quoted namespace matcher value', () => {
    expect(validateNamespaceLockdown('{namespace=`prod`} |= "error"', 'prod')).toBe(true);
  });

  it('rejects a negated namespace matcher even when the value matches', () => {
    expect(validateNamespaceLockdown('{namespace!="prod"} |= "error"', 'prod')).toBe(false);
    expect(validateNamespaceLockdown('{namespace!~"prod"} |= "error"', 'prod')).toBe(false);
  });

  it('rejects a malformed selector rather than guessing', () => {
    expect(validateNamespaceLockdown('{namespace=prod} |= "error"', 'prod')).toBe(false);
  });

  it('rejects a bypass where a decoy selector is hidden in a leading comment', () => {
    // Loki ignores the commented line and executes the real (different) selector.
    const query = '# {namespace="prod"}\n{namespace="evil"} |= "ERROR"';
    expect(validateNamespaceLockdown(query, 'prod')).toBe(false);
    expect(validateNamespaceLockdown(query, 'evil')).toBe(true);
  });

  it('does not treat a "#" inside a quoted value as a comment', () => {
    expect(validateNamespaceLockdown('{namespace="pro#d"} |= "error"', 'pro#d')).toBe(true);
  });

  it('rejects a metric query where only the first of multiple stream selectors matches the locked namespace', () => {
    const query = 'sum(rate({namespace="prod"}[5m])) / sum(rate({namespace="evil"}[5m]))';
    expect(validateNamespaceLockdown(query, 'prod')).toBe(false);
  });

  it('accepts a metric query where every stream selector matches the locked namespace', () => {
    const query = 'sum(rate({namespace="prod"}[5m])) / sum(rate({namespace="prod", app="api"}[5m]))';
    expect(validateNamespaceLockdown(query, 'prod')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Successful queries
// ---------------------------------------------------------------------------

describe('runLokiQuery — success', () => {
  it('calls /loki/api/v1/query_range with the LogQL query', async () => {
    const fetchMock = mockFetch('{"status":"success","data":{"result":[]}}');

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
    const fetchMock = mockFetch('{}');

    await runLokiQuery({ query: '{app="api"}' }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('direction=backward');
    expect(url).toContain('limit=100');
    expect(url).toContain('start=');
  });

  it('uses the provided limit', async () => {
    const fetchMock = mockFetch('{}');

    await runLokiQuery({ query: '{app="api"}', limit: 500 }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('limit=500');
  });

  it('resolves relative start/end times to ISO8601 in the URL', async () => {
    const fetchMock = mockFetch('{}');

    await runLokiQuery({ query: '{app="api"}', start: '-2h', end: '-30m' }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain('start=-2h');
    expect(url).not.toContain('end=-30m');
    expect(url).toContain('start=');
    expect(url).toContain('end=');
  });

  it('passes ISO8601 start through unchanged', async () => {
    const fetchMock = mockFetch('{}');

    const start = '2024-01-01T00:00:00.000Z';
    await runLokiQuery({ query: '{app="api"}', start }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
    expect(decoded).toContain(start);
  });

  it('strips trailing slash from base URL', async () => {
    const fetchMock = mockFetch('{}');

    await runLokiQuery({ query: '{app="api"}' }, { ...BASE_CONFIG, url: 'http://loki:3100/' });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain('//loki/api/v1/query_range');
    expect(url).toContain('http://loki:3100/loki/api/v1/query_range');
  });
});

// ---------------------------------------------------------------------------
// Limit clamping
// ---------------------------------------------------------------------------

describe('runLokiQuery — limit clamping', () => {
  it('clamps limit to MAX_LIMIT (5000) when exceeded', async () => {
    const fetchMock = mockFetch('{}');

    await runLokiQuery({ query: '{app="api"}', limit: 999_999 }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('limit=5000');
    expect(url).not.toContain('limit=999999');
  });

  it('clamps limit to 1 when zero or negative', async () => {
    const fetchMock = mockFetch('{}');

    await runLokiQuery({ query: '{app="api"}', limit: 0 }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('limit=1');
  });

  it('uses DEFAULT_LIMIT when limit is null', async () => {
    const fetchMock = mockFetch('{}');

    await runLokiQuery({ query: '{app="api"}', limit: null }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('limit=100');
  });
});

// ---------------------------------------------------------------------------
// Namespace lockdown
// ---------------------------------------------------------------------------

describe('runLokiQuery — namespace lockdown', () => {
  const LOCKED_CONFIG: LokiConfig = { ...BASE_CONFIG, lockedNamespace: 'prod' };

  it('allows queries that include the locked namespace', async () => {
    const fetchMock = mockFetch('{}');

    const result = await runLokiQuery(
      { query: '{namespace="prod", app="api"} |= "ERROR"' },
      LOCKED_CONFIG,
    );

    expect(result).not.toMatch(/BLOCKED/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('blocks queries without the locked namespace selector', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runLokiQuery(
      { query: '{app="api"} |= "ERROR"' },
      LOCKED_CONFIG,
    );

    expect(result).toMatch(/BLOCKED/);
    expect(result).toContain('prod');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks queries targeting a different namespace', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runLokiQuery(
      { query: '{namespace="staging"} |= "ERROR"' },
      LOCKED_CONFIG,
    );

    expect(result).toMatch(/BLOCKED/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks wildcard namespace selectors', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runLokiQuery(
      { query: '{namespace=~".+"} |= "ERROR"' },
      LOCKED_CONFIG,
    );

    expect(result).toMatch(/BLOCKED/);
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('omits the body detail when the error response has an empty body', async () => {
    mockFetch('', 400);
    const result = await runLokiQuery({ query: '{app="api"}' }, BASE_CONFIG);
    expect(result).toMatch(/Loki HTTP 400/);
    expect(result).not.toContain(':');
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
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(makeAbortError()));

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

  it('uses String(err) when the thrown value is not an Error instance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('plain string error'));

    const result = await runLokiQuery({ query: '{app="api"}' }, BASE_CONFIG);
    expect(result).toMatch(/Loki query failed/i);
    expect(result).toContain('plain string error');
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
    expect(result).toContain('[output truncated');
  });

  it('does not truncate responses under the limit', async () => {
    const small = '{"status":"success","data":{"result":[]}}';
    mockFetch(small);

    const result = await runLokiQuery({ query: '{app="api"}' }, BASE_CONFIG);
    expect(result).toBe(small);
    expect(result).not.toContain('[output truncated');
  });
});

// ---------------------------------------------------------------------------
// Abort timeout — covers the `() => controller.abort()` setTimeout callback
// ---------------------------------------------------------------------------

describe('runLokiQuery — abort timeout', () => {
  it('fires the setTimeout abort after timeoutMs and returns a timeout message', async () => {
    vi.useFakeTimers();

    mockFetchHangsUntilAbort();

    const queryPromise = runLokiQuery(
      { query: '{app="api"}' },
      { ...BASE_CONFIG, timeoutMs: 3_000 },
    );

    await vi.advanceTimersByTimeAsync(3_001);
    const result = await queryPromise;

    expect(result).toMatch(/timed out/i);
    expect(result).toContain('3000ms');
  });
});

// ---------------------------------------------------------------------------
// response.text() catch fallback — covers `() => ''` on non-2xx path
// ---------------------------------------------------------------------------

describe('runLokiQuery — response.text() failure', () => {
  it('returns an HTTP error without body detail when text() throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: () => Promise.reject(new Error('stream closed')),
    }));

    const result = await runLokiQuery({ query: '{app="api"}' }, BASE_CONFIG);

    expect(result).toMatch(/Loki HTTP 503/);
    expect(result).not.toContain(':');
  });
});
