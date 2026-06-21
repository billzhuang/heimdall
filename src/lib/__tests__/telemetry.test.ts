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
  percentile,
  _resetTelemetry,
} from '../telemetry.ts';

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
