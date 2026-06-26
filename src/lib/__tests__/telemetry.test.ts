import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initTelemetry,
  recordCacheHit,
  recordCacheMiss,
  recordToolCall,
  recordTokens,
  getTelemetrySnapshot,
  emitTelemetry,
  isTelemetryEnabled,
  percentile,
  _resetTelemetry,
  parseOtelHeaders,
  formatPrometheusMetrics,
  buildOtlpPayload,
  pushOtlpMetrics,
  startOtelExport,
  stopOtelExport,
} from '../telemetry.ts';
import type { TelemetrySnapshot } from '../telemetry.ts';

beforeEach(() => {
  _resetTelemetry();
  delete process.env.HEIMDALL_TELEMETRY_FILE;
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetTelemetry();
  delete process.env.HEIMDALL_TELEMETRY_FILE;
});

describe('percentile', () => {
  it('returns 0 for an empty array', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([], 99)).toBe(0);
  });

  it('returns the single value for a one-element array at any percentile', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it('computes p50 correctly for an even-length array', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
  });

  it('computes p99 correctly', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(values, 99)).toBe(99);
  });

  it('sorts before computing (handles unsorted input)', () => {
    expect(percentile([40, 10, 30, 20], 50)).toBe(20);
  });

  it('does not mutate the input array', () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('recording functions are no-ops when disabled', () => {
  it('returns zero snapshot when not initialised', () => {
    recordCacheHit();
    recordCacheMiss();
    recordToolCall(100);
    recordTokens(500, 200);

    const snap = getTelemetrySnapshot();
    expect(snap.cacheHits).toBe(0);
    expect(snap.cacheMisses).toBe(0);
    expect(snap.toolCallCount).toBe(0);
    expect(snap.totalInputTokens).toBe(0);
    expect(snap.totalOutputTokens).toBe(0);
  });
});

describe('recording functions accumulate correctly when enabled', () => {
  beforeEach(() => {
    initTelemetry({ enabled: true });
  });

  it('counts cache hits', () => {
    recordCacheHit();
    recordCacheHit();
    expect(getTelemetrySnapshot().cacheHits).toBe(2);
  });

  it('counts cache misses', () => {
    recordCacheMiss();
    expect(getTelemetrySnapshot().cacheMisses).toBe(1);
  });

  it('tracks tool call latencies and computes p50/p99', () => {
    const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    for (const ms of latencies) recordToolCall(ms);

    const snap = getTelemetrySnapshot();
    expect(snap.toolCallCount).toBe(10);
    expect(snap.p50LatencyMs).toBe(50);
    expect(snap.p99LatencyMs).toBe(100);
  });

  it('accumulates token counts', () => {
    recordTokens(100, 50);
    recordTokens(200, 75);
    const snap = getTelemetrySnapshot();
    expect(snap.totalInputTokens).toBe(300);
    expect(snap.totalOutputTokens).toBe(125);
  });

  it('snapshot includes all fields with correct types', () => {
    const snap = getTelemetrySnapshot();
    expect(typeof snap.totalInputTokens).toBe('number');
    expect(typeof snap.totalOutputTokens).toBe('number');
    expect(typeof snap.cacheHits).toBe('number');
    expect(typeof snap.cacheMisses).toBe('number');
    expect(typeof snap.toolCallCount).toBe('number');
    expect(typeof snap.p50LatencyMs).toBe('number');
    expect(typeof snap.p99LatencyMs).toBe('number');
  });
});

describe('emitTelemetry — stderr sink', () => {
  it('writes a JSON blob to stderr when no file is configured', () => {
    initTelemetry({ enabled: true });
    recordCacheHit();
    recordToolCall(25);

    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });

    emitTelemetry();

    expect(lines).toHaveLength(1);
    const snap = JSON.parse(lines[0].trimEnd()) as Record<string, number>;
    expect(snap.cacheHits).toBe(1);
    expect(snap.toolCallCount).toBe(1);
    expect(snap.p50LatencyMs).toBe(25);
  });
});

describe('emitTelemetry — file sink', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'heimdall-telemetry-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a JSON blob to the configured file', async () => {
    const filePath = join(tmpDir, 'perf.json');
    initTelemetry({ enabled: true, file: filePath });
    recordCacheMiss();
    recordCacheMiss();
    recordTokens(1000, 300);

    emitTelemetry();

    const content = await readFile(filePath, 'utf8');
    const snap = JSON.parse(content.trimEnd()) as Record<string, number>;
    expect(snap.cacheMisses).toBe(2);
    expect(snap.totalInputTokens).toBe(1000);
    expect(snap.totalOutputTokens).toBe(300);
  });

  it('creates parent directories when they do not exist', async () => {
    const filePath = join(tmpDir, 'nested', 'deep', 'perf.json');
    initTelemetry({ enabled: true, file: filePath });
    emitTelemetry();

    const content = await readFile(filePath, 'utf8');
    expect(() => JSON.parse(content)).not.toThrow();
  });
});

describe('HEIMDALL_TELEMETRY_FILE env var auto-enables telemetry', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'heimdall-telemetry-env-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('auto-enables telemetry and uses the env-var path', async () => {
    const filePath = join(tmpDir, 'auto.json');
    process.env.HEIMDALL_TELEMETRY_FILE = filePath;
    initTelemetry({ enabled: false });

    recordCacheHit();
    recordCacheHit();
    recordCacheHit();

    emitTelemetry();

    const content = await readFile(filePath, 'utf8');
    const snap = JSON.parse(content.trimEnd()) as Record<string, number>;
    expect(snap.cacheHits).toBe(3);
  });
});

describe('isTelemetryEnabled', () => {
  it('returns false before initTelemetry is called', () => {
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('returns true after initTelemetry with enabled: true', () => {
    initTelemetry({ enabled: true });
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('returns false after initTelemetry with enabled: false and no env var', () => {
    initTelemetry({ enabled: false });
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('returns true when auto-enabled via HEIMDALL_TELEMETRY_FILE even if config.enabled is false', () => {
    process.env.HEIMDALL_TELEMETRY_FILE = '/tmp/does-not-matter.json';
    initTelemetry({ enabled: false });
    expect(isTelemetryEnabled()).toBe(true);
    delete process.env.HEIMDALL_TELEMETRY_FILE;
  });
});

describe('double-registration guard (_exitHandlerRegistered)', () => {
  it('registers the exit handler only once across multiple initTelemetry calls', () => {
    const onceSpy = vi.spyOn(process, 'once').mockImplementation(() => process);
    initTelemetry({ enabled: true });
    initTelemetry({ enabled: true });
    initTelemetry({ enabled: true });
    const exitCalls = onceSpy.mock.calls.filter(([event]) => event === 'exit');
    expect(exitCalls).toHaveLength(1);
  });

  it('re-registers the exit handler after a full reset', () => {
    const onceSpy = vi.spyOn(process, 'once').mockImplementation(() => process);
    initTelemetry({ enabled: true });
    _resetTelemetry();
    initTelemetry({ enabled: true });
    const exitCalls = onceSpy.mock.calls.filter(([event]) => event === 'exit');
    expect(exitCalls).toHaveLength(2);
  });
});

describe('emitTelemetry bypasses the _enabled guard and always emits', () => {
  it('emits a zero-value snapshot to stderr even when telemetry is not initialised', () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });

    emitTelemetry();

    expect(lines).toHaveLength(1);
    const snap = JSON.parse(lines[0].trimEnd()) as Record<string, number>;
    expect(snap.cacheHits).toBe(0);
    expect(snap.toolCallCount).toBe(0);
  });
});

describe('cache hit rate correctness (acceptance criteria)', () => {
  it('computes correct cache hit rate across repeated identical queries', () => {
    initTelemetry({ enabled: true });

    // 3 misses (first queries), then 6 hits (cached reads)
    for (let i = 0; i < 3; i++) recordCacheMiss();
    for (let i = 0; i < 6; i++) recordCacheHit();

    const snap = getTelemetrySnapshot();
    expect(snap.cacheHits).toBe(6);
    expect(snap.cacheMisses).toBe(3);
    const total = snap.cacheHits + snap.cacheMisses;
    expect(total).toBe(9);
    // hit rate = 6/9 ≈ 0.667
    expect(snap.cacheHits / total).toBeCloseTo(0.667, 2);
  });
});

// ─── OpenTelemetry export ────────────────────────────────────────────────────

describe('parseOtelHeaders', () => {
  it('returns empty object for empty string', () => {
    expect(parseOtelHeaders('')).toEqual({});
    expect(parseOtelHeaders('   ')).toEqual({});
  });

  it('parses a single key=value pair', () => {
    expect(parseOtelHeaders('Authorization=Bearer token123')).toEqual({
      Authorization: 'Bearer token123',
    });
  });

  it('parses multiple comma-separated pairs', () => {
    const result = parseOtelHeaders('X-Api-Key=abc,X-Tenant=my-org');
    expect(result).toEqual({ 'X-Api-Key': 'abc', 'X-Tenant': 'my-org' });
  });

  it('URL-decodes percent-encoded values', () => {
    const result = parseOtelHeaders('Authorization=Bearer%20token%2Fwith%2Fslashes');
    expect(result['Authorization']).toBe('Bearer token/with/slashes');
  });

  it('skips pairs without an equals sign', () => {
    const result = parseOtelHeaders('Authorization=Bearer token,badentry,X-Tenant=org');
    expect(result).toEqual({ Authorization: 'Bearer token', 'X-Tenant': 'org' });
  });

  it('handles values that contain equals signs', () => {
    const result = parseOtelHeaders('X-Token=a=b=c');
    expect(result['X-Token']).toBe('a=b=c');
  });

  it('falls back to raw key/value on malformed percent-encoding', () => {
    // %XY is not valid percent-encoding; decodeURIComponent throws URIError
    const result = parseOtelHeaders('Authorization=Bearer%XYtoken');
    expect(result['Authorization']).toBe('Bearer%XYtoken');
  });
});

describe('formatPrometheusMetrics', () => {
  const snapshot: TelemetrySnapshot = {
    totalInputTokens: 1000,
    totalOutputTokens: 200,
    cacheHits: 5,
    cacheMisses: 3,
    toolCallCount: 10,
    p50LatencyMs: 150,
    p99LatencyMs: 900,
  };

  it('includes all expected metric names', () => {
    const output = formatPrometheusMetrics(snapshot);
    expect(output).toContain('heimdall_tool_calls_total');
    expect(output).toContain('heimdall_kubectl_cache_hits_total');
    expect(output).toContain('heimdall_kubectl_cache_misses_total');
    expect(output).toContain('heimdall_llm_input_tokens_total');
    expect(output).toContain('heimdall_llm_output_tokens_total');
    expect(output).toContain('heimdall_tool_latency_p50_milliseconds');
    expect(output).toContain('heimdall_tool_latency_p99_milliseconds');
  });

  it('emits correct values', () => {
    const output = formatPrometheusMetrics(snapshot);
    expect(output).toContain('heimdall_tool_calls_total{service="heimdall"} 10');
    expect(output).toContain('heimdall_kubectl_cache_hits_total{service="heimdall"} 5');
    expect(output).toContain('heimdall_llm_input_tokens_total{service="heimdall"} 1000');
    expect(output).toContain('heimdall_tool_latency_p99_milliseconds{service="heimdall"} 900');
  });

  it('uses custom service name in labels', () => {
    const output = formatPrometheusMetrics(snapshot, 'my-heimdall');
    expect(output).toContain('{service="my-heimdall"}');
    expect(output).not.toContain('{service="heimdall"}');
  });

  it('includes HELP and TYPE lines', () => {
    const output = formatPrometheusMetrics(snapshot);
    expect(output).toMatch(/^# HELP heimdall_tool_calls_total /m);
    expect(output).toMatch(/^# TYPE heimdall_tool_calls_total counter$/m);
    expect(output).toMatch(/^# TYPE heimdall_tool_latency_p50_milliseconds gauge$/m);
  });

  it('ends with a newline', () => {
    const output = formatPrometheusMetrics(snapshot);
    expect(output.endsWith('\n')).toBe(true);
  });

  it('defaults service name to "heimdall" when not provided', () => {
    const output = formatPrometheusMetrics(snapshot);
    expect(output).toContain('{service="heimdall"}');
  });

  it('escapes double-quotes and backslashes in service name', () => {
    const output = formatPrometheusMetrics(snapshot, 'svc"with"quotes');
    expect(output).toContain('{service="svc\\"with\\"quotes"}');
    expect(output).not.toContain('{service="svc"with"quotes"}');
  });
});

describe('buildOtlpPayload', () => {
  const snapshot: TelemetrySnapshot = {
    totalInputTokens: 500,
    totalOutputTokens: 100,
    cacheHits: 8,
    cacheMisses: 2,
    toolCallCount: 20,
    p50LatencyMs: 80,
    p99LatencyMs: 500,
  };
  // Use small ms values that are safely representable as JS integers
  // (avoids floating-point precision issues near MAX_SAFE_INTEGER).
  const START_MS = 1_000_000; // 1000 seconds past epoch
  const NOW_MS = 1_060_000; // 1060 seconds past epoch

  it('returns an object with resourceMetrics array', () => {
    const payload = buildOtlpPayload(snapshot, 'heimdall', START_MS, NOW_MS) as Record<string, unknown>;
    expect(Array.isArray(payload['resourceMetrics'])).toBe(true);
  });

  it('sets service.name resource attribute', () => {
    const payload = buildOtlpPayload(snapshot, 'my-service', START_MS, NOW_MS) as {
      resourceMetrics: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue: string } }> } }>;
    };
    const attrs = payload.resourceMetrics[0].resource.attributes;
    const nameAttr = attrs.find((a) => a.key === 'service.name');
    expect(nameAttr?.value.stringValue).toBe('my-service');
  });

  it('contains the expected number of metrics (7)', () => {
    const payload = buildOtlpPayload(snapshot, 'heimdall', START_MS, NOW_MS) as {
      resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: unknown[] }> }>;
    };
    const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
    expect(metrics).toHaveLength(7);
  });

  it('encodes sum metrics with correct asInt values', () => {
    const payload = buildOtlpPayload(snapshot, 'heimdall', START_MS, NOW_MS) as {
      resourceMetrics: Array<{
        scopeMetrics: Array<{
          metrics: Array<{ name: string; sum?: { dataPoints: Array<{ asInt: number }> } }>;
        }>;
      }>;
    };
    const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
    const toolCalls = metrics.find((m) => m.name === 'heimdall.tool.calls');
    expect(toolCalls?.sum?.dataPoints[0].asInt).toBe(20);
    const inputTokens = metrics.find((m) => m.name === 'heimdall.llm.input_tokens');
    expect(inputTokens?.sum?.dataPoints[0].asInt).toBe(500);
  });

  it('encodes gauge metrics with correct asDouble values', () => {
    const payload = buildOtlpPayload(snapshot, 'heimdall', START_MS, NOW_MS) as {
      resourceMetrics: Array<{
        scopeMetrics: Array<{
          metrics: Array<{ name: string; gauge?: { dataPoints: Array<{ asDouble: number }> } }>;
        }>;
      }>;
    };
    const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
    const p99 = metrics.find((m) => m.name === 'heimdall.tool.latency_p99_ms');
    expect(p99?.gauge?.dataPoints[0].asDouble).toBe(500);
  });

  it('encodes timestamps as nanosecond strings without precision loss', () => {
    const payload = buildOtlpPayload(snapshot, 'heimdall', START_MS, NOW_MS) as {
      resourceMetrics: Array<{
        scopeMetrics: Array<{
          metrics: Array<{
            sum?: { dataPoints: Array<{ startTimeUnixNano: string; timeUnixNano: string }> };
          }>;
        }>;
      }>;
    };
    const dp = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum!.dataPoints[0];
    expect(typeof dp.startTimeUnixNano).toBe('string');
    expect(typeof dp.timeUnixNano).toBe('string');
    // 1_000_000 ms = 1000 s → 1000 * 10^9 ns = 1_000_000_000_000 ns
    expect(dp.startTimeUnixNano).toBe('1000000000000');
    // 1_060_000 ms = 1060 s → 1_060_000_000_000 ns
    expect(dp.timeUnixNano).toBe('1060000000000');
  });

  it('handles sub-second (ms remainder) timestamps correctly', () => {
    const payload = buildOtlpPayload(snapshot, 'heimdall', 1_500_123, 1_500_456) as {
      resourceMetrics: Array<{
        scopeMetrics: Array<{
          metrics: Array<{
            sum?: { dataPoints: Array<{ startTimeUnixNano: string; timeUnixNano: string }> };
          }>;
        }>;
      }>;
    };
    const dp = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum!.dataPoints[0];
    // 1_500_123 ms = 1500 s + 123 ms → 1500 * 10^9 + 123 * 10^6 = 1_500_123_000_000 ns
    expect(dp.startTimeUnixNano).toBe('1500123000000');
    // 1_500_456 ms → 1500 * 10^9 + 456 * 10^6 = 1_500_456_000_000 ns
    expect(dp.timeUnixNano).toBe('1500456000000');
  });
});

describe('pushOtlpMetrics', () => {
  const snapshot: TelemetrySnapshot = {
    totalInputTokens: 100,
    totalOutputTokens: 20,
    cacheHits: 2,
    cacheMisses: 1,
    toolCallCount: 5,
    p50LatencyMs: 50,
    p99LatencyMs: 200,
  };

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['OTEL_EXPORTER_OTLP_HEADERS'];
  });

  it('POSTs to endpoint/v1/metrics with JSON content-type', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: vi.fn().mockResolvedValue('') });
    vi.stubGlobal('fetch', mockFetch);

    await pushOtlpMetrics('http://localhost:4318', {}, snapshot, 'heimdall', 0, 60_000);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4318/v1/metrics');
    expect((options.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(options.method).toBe('POST');
    expect(typeof options.body).toBe('string');
    const body = JSON.parse(options.body as string) as { resourceMetrics: unknown[] };
    expect(Array.isArray(body.resourceMetrics)).toBe(true);
  });

  it('appends /v1/metrics when endpoint has trailing slash', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue('') });
    vi.stubGlobal('fetch', mockFetch);

    await pushOtlpMetrics('http://localhost:4318/', {}, snapshot, 'heimdall', 0, 60_000);

    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe('http://localhost:4318/v1/metrics');
  });

  it('forwards custom auth headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue('') });
    vi.stubGlobal('fetch', mockFetch);

    await pushOtlpMetrics(
      'http://collector:4318',
      { Authorization: 'Bearer secret' },
      snapshot,
      'heimdall',
      0,
      60_000,
    );

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((options.headers as Record<string, string>)['Authorization']).toBe('Bearer secret');
  });

  it('logs to stderr on non-OK HTTP response (does not throw)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: vi.fn().mockResolvedValue('') }));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(
      pushOtlpMetrics('http://localhost:4318', {}, snapshot, 'heimdall', 0, 60_000),
    ).resolves.toBeUndefined();

    expect(stderrSpy.mock.calls.some((args) => String(args[0]).includes('503'))).toBe(true);
  });

  it('logs to stderr on network error (does not throw)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(
      pushOtlpMetrics('http://localhost:4318', {}, snapshot, 'heimdall', 0, 60_000),
    ).resolves.toBeUndefined();

    expect(stderrSpy.mock.calls.some((args) => String(args[0]).includes('ECONNREFUSED'))).toBe(true);
  });
});

describe('startOtelExport / stopOtelExport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    delete process.env['OTEL_METRIC_EXPORT_INTERVAL'];
    delete process.env['OTEL_SERVICE_NAME'];
    delete process.env['OTEL_EXPORTER_OTLP_HEADERS'];
    _resetTelemetry();
    initTelemetry({ enabled: true });
  });

  afterEach(() => {
    stopOtelExport();
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetTelemetry();
  });

  it('is a no-op when disabled and no env endpoint is set', () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    startOtelExport({ enabled: false });
    vi.advanceTimersByTime(120_000);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('logs to stderr when enabled but no endpoint provided', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    startOtelExport({ enabled: true, endpoint: null });
    expect(stderrSpy.mock.calls.some((args) => String(args[0]).includes('no endpoint'))).toBe(true);
  });

  it('pushes metrics at each interval tick', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue('') });
    vi.stubGlobal('fetch', mockFetch);

    startOtelExport({ enabled: true, endpoint: 'http://otel:4318', exportIntervalMs: 10_000 });
    expect(mockFetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('stopOtelExport halts further pushes', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue('') });
    vi.stubGlobal('fetch', mockFetch);

    startOtelExport({ enabled: true, endpoint: 'http://otel:4318', exportIntervalMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    stopOtelExport();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reads endpoint from OTEL_EXPORTER_OTLP_ENDPOINT env var', async () => {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://env-collector:4318';
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue('') });
    vi.stubGlobal('fetch', mockFetch);

    startOtelExport({ enabled: false });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe('http://env-collector:4318/v1/metrics');
  });

  it('uses OTEL_SERVICE_NAME env var for service name in payload', async () => {
    process.env['OTEL_SERVICE_NAME'] = 'custom-sre-agent';
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue('') });
    vi.stubGlobal('fetch', mockFetch);

    startOtelExport({ enabled: true, endpoint: 'http://otel:4318', exportIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as {
      resourceMetrics: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue: string } }> } }>;
    };
    const nameAttr = body.resourceMetrics[0].resource.attributes.find((a) => a.key === 'service.name');
    expect(nameAttr?.value.stringValue).toBe('custom-sre-agent');
  });

  it('second startOtelExport call is a no-op when already running', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue('') });
    vi.stubGlobal('fetch', mockFetch);

    startOtelExport({ enabled: true, endpoint: 'http://otel:4318', exportIntervalMs: 5_000 });
    startOtelExport({ enabled: true, endpoint: 'http://otel:4318', exportIntervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(5_000);
    // Only one interval at 5s cadence, not two intervals
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
