import { describe, it, expect, vi, afterEach } from 'vitest';
import { runKubecostQuery } from '../kubecost.ts';
import type { KubecostConfig } from '../kubecost.ts';
import { mockFetch, makeAbortError } from './test-helpers.ts';

const BASE_CONFIG: KubecostConfig = { url: 'http://kubecost:9090', timeoutMs: 5_000 };

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Allocation queries
// ---------------------------------------------------------------------------

describe('runKubecostQuery — allocation', () => {
  it('calls /model/allocation with the correct query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"data":[]}'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await runKubecostQuery('allocation', { window: '7d', aggregate: 'namespace' }, BASE_CONFIG);

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/model/allocation');
    expect(url).toContain('window=7d');
    expect(url).toContain('aggregate=namespace');
    expect(url).toContain('accumulate=true');
  });

  it('appends filterNamespaces when namespace is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{}'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await runKubecostQuery(
      'allocation',
      { window: '7d', aggregate: 'controller', namespace: 'prod' },
      BASE_CONFIG,
    );

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('filterNamespaces=prod');
  });

  it('omits filterNamespaces when namespace is not provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{}'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await runKubecostQuery('allocation', { window: '7d', aggregate: 'namespace' }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain('filterNamespaces');
  });

  it('sets accumulate=false when explicitly requested', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{}'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await runKubecostQuery(
      'allocation',
      { window: '30d', aggregate: 'namespace', accumulate: false },
      BASE_CONFIG,
    );

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('accumulate=false');
  });

  it('returns the raw JSON response body on success', async () => {
    const payload = '{"code":200,"data":[{"namespace":"prod","totalCost":1.23}]}';
    mockFetch(payload);

    const result = await runKubecostQuery('allocation', { window: '7d', aggregate: 'namespace' }, BASE_CONFIG);
    expect(result).toBe(payload);
  });

  it('strips trailing slash from the base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    await runKubecostQuery(
      'allocation',
      { window: '7d', aggregate: 'namespace' },
      { ...BASE_CONFIG, url: 'http://kubecost:9090/' },
    );

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain('//model/allocation');
    expect(url).toContain('http://kubecost:9090/model/allocation');
  });
});

// ---------------------------------------------------------------------------
// Assets queries
// ---------------------------------------------------------------------------

describe('runKubecostQuery — assets', () => {
  it('calls /model/assets for the assets endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{}'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await runKubecostQuery('assets', { window: '7d', aggregate: 'cluster' }, BASE_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/model/assets');
    expect(url).not.toContain('/model/allocation');
  });

  it('returns an error when namespace is provided for assets queries', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runKubecostQuery(
      'assets',
      { window: '7d', aggregate: 'cluster', namespace: 'prod' },
      BASE_CONFIG,
    );

    expect(result).toMatch(/Error/);
    expect(result).toMatch(/namespace.*allocation|allocation.*namespace/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats null namespace as absent for assets queries (no error, no filterNamespaces)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runKubecostQuery(
      'assets',
      { window: '7d', aggregate: 'cluster', namespace: null },
      BASE_CONFIG,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain('filterNamespaces');
    expect(result).not.toMatch(/Error/);
  });
});

// ---------------------------------------------------------------------------
// Namespace lockdown
// ---------------------------------------------------------------------------

describe('runKubecostQuery — namespace lockdown', () => {
  const LOCKED_CONFIG: KubecostConfig = { ...BASE_CONFIG, lockedNamespace: 'prod' };

  it('forces filterNamespaces to the locked namespace for allocation queries', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    await runKubecostQuery('allocation', { window: '7d', aggregate: 'namespace' }, LOCKED_CONFIG);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('filterNamespaces=prod');
  });

  it('allows allocation queries that explicitly match the locked namespace', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runKubecostQuery(
      'allocation',
      { window: '7d', aggregate: 'namespace', namespace: 'prod' },
      LOCKED_CONFIG,
    );

    expect(result).not.toMatch(/BLOCKED/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('blocks allocation queries that specify a different namespace than the locked one', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runKubecostQuery(
      'allocation',
      { window: '7d', aggregate: 'namespace', namespace: 'staging' },
      LOCKED_CONFIG,
    );

    expect(result).toMatch(/BLOCKED/);
    expect(result).toContain('prod');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows assets queries even when namespace is locked (lockdown only applies to allocation)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    await runKubecostQuery('assets', { window: '7d', aggregate: 'cluster' }, LOCKED_CONFIG);

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain('filterNamespaces');
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe('runKubecostQuery — validation', () => {
  it('returns an error when window is empty', async () => {
    const result = await runKubecostQuery('allocation', { window: '', aggregate: 'namespace' }, BASE_CONFIG);
    expect(result).toMatch(/window/i);
    expect(result).toMatch(/error/i);
  });

  it('does not call fetch when window is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await runKubecostQuery('allocation', { window: '', aggregate: 'namespace' }, BASE_CONFIG);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// HTTP errors
// ---------------------------------------------------------------------------

describe('runKubecostQuery — HTTP errors', () => {
  it('returns an error message on non-2xx HTTP status', async () => {
    mockFetch('bad request', 400);
    const result = await runKubecostQuery('allocation', { window: '7d', aggregate: 'namespace' }, BASE_CONFIG);
    expect(result).toMatch(/400/);
  });

  it('includes a snippet of the response body in the error', async () => {
    mockFetch('invalid window format', 400);
    const result = await runKubecostQuery('allocation', { window: '7d', aggregate: 'namespace' }, BASE_CONFIG);
    expect(result).toContain('invalid window format');
  });

  it('omits the body detail when the error response has an empty body', async () => {
    mockFetch('', 400);
    const result = await runKubecostQuery('allocation', { window: '7d', aggregate: 'namespace' }, BASE_CONFIG);
    expect(result).toMatch(/Kubecost HTTP 400/);
    expect(result).not.toContain(':');
  });
});

// ---------------------------------------------------------------------------
// Network / timeout errors
// ---------------------------------------------------------------------------

describe('runKubecostQuery — malformed URL', () => {
  it('returns a clean error message when config.url is not a valid URL', async () => {
    const result = await runKubecostQuery(
      'allocation',
      { window: '7d', aggregate: 'namespace' },
      { url: 'not-a-valid-url', timeoutMs: 5_000 },
    );
    expect(result).toMatch(/Kubecost query failed/i);
  });
});

describe('runKubecostQuery — network errors', () => {
  it('returns a timeout message on AbortError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(makeAbortError()));

    const result = await runKubecostQuery(
      'allocation',
      { window: '7d', aggregate: 'namespace' },
      { ...BASE_CONFIG, timeoutMs: 100 },
    );
    expect(result).toMatch(/timed out/i);
    expect(result).toContain('100ms');
  });

  it('returns a descriptive message on generic fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await runKubecostQuery('allocation', { window: '7d', aggregate: 'namespace' }, BASE_CONFIG);
    expect(result).toMatch(/Kubecost query failed/i);
    expect(result).toContain('ECONNREFUSED');
  });

  it('uses String(err) when the thrown value is not an Error instance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('plain string error'));

    const result = await runKubecostQuery('allocation', { window: '7d', aggregate: 'namespace' }, BASE_CONFIG);
    expect(result).toMatch(/Kubecost query failed/i);
    expect(result).toContain('plain string error');
  });
});

// ---------------------------------------------------------------------------
// Output truncation
// ---------------------------------------------------------------------------

describe('runKubecostQuery — output truncation', () => {
  it('truncates responses longer than 20 000 characters', async () => {
    const huge = 'x'.repeat(25_000);
    mockFetch(huge);

    const result = await runKubecostQuery('allocation', { window: '7d', aggregate: 'namespace' }, BASE_CONFIG);
    expect(result.length).toBeLessThan(25_000);
    expect(result).toContain('[output truncated');
  });

  it('does not truncate responses under the limit', async () => {
    const small = '{"code":200,"data":[]}';
    mockFetch(small);

    const result = await runKubecostQuery('allocation', { window: '7d', aggregate: 'namespace' }, BASE_CONFIG);
    expect(result).toBe(small);
    expect(result).not.toContain('[output truncated');
  });
});
