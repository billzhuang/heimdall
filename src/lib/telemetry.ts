/**
 * In-process telemetry tracker and OpenTelemetry export for Heimdall.
 *
 * Accumulates tool-call latencies, kubectl cache hit/miss counts, and token
 * usage in process-level singleton state. When enabled (via config or
 * HEIMDALL_TELEMETRY_FILE env var), emits a JSON summary blob to stderr or a
 * file at process exit.
 *
 * OpenTelemetry export: when `startOtelExport()` is called (or
 * OTEL_EXPORTER_OTLP_ENDPOINT is set), metrics are pushed periodically to an
 * OTLP/HTTP JSON endpoint. The `/metrics` HTTP server endpoint returns the
 * same data in Prometheus exposition format for pull-based scraping.
 *
 * All recording functions are synchronous no-ops when disabled, so they add
 * no measurable overhead to the hot path.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { withTimeout } from './http.ts';

export interface TelemetryConfig {
  enabled: boolean;
  /** Path to write the JSON blob. Omit/null to write to stderr. */
  file?: string | null;
}

export interface TelemetrySnapshot {
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheHits: number;
  cacheMisses: number;
  toolCallCount: number;
  p50LatencyMs: number;
  p99LatencyMs: number;
}

// Process-level singleton state.
let _enabled = false;
let _telemetryFile: string | null = null;
let _totalInputTokens = 0;
let _totalOutputTokens = 0;
let _cacheHits = 0;
let _cacheMisses = 0;
let _latenciesMs: number[] = [];
let _exitHandlerRegistered = false;

/**
 * Initialise telemetry for this process. Call once at agent startup.
 * Also auto-enables when HEIMDALL_TELEMETRY_FILE env var is set.
 */
export function initTelemetry(config: TelemetryConfig): void {
  const envFile = process.env.HEIMDALL_TELEMETRY_FILE || null;
  _enabled = config.enabled || !!envFile;
  _telemetryFile = config.file ?? envFile;

  if (_enabled && !_exitHandlerRegistered) {
    _exitHandlerRegistered = true;
    process.once('exit', () => {
      if (_enabled) _emitSync();
    });
  }
}

/** Record a kubectl cache hit. */
export function recordCacheHit(): void {
  if (!_enabled) return;
  _cacheHits++;
}

/** Record a kubectl cache miss (cacheable command, no valid cached entry). */
export function recordCacheMiss(): void {
  if (!_enabled) return;
  _cacheMisses++;
}

/** Record a completed tool call with its wall-clock duration in milliseconds. */
export function recordToolCall(durationMs: number): void {
  if (!_enabled) return;
  _latenciesMs.push(durationMs);
}

/** Record LLM token usage (call from wherever usage data is available). */
export function recordTokens(inputTokens: number, outputTokens: number): void {
  if (!_enabled) return;
  _totalInputTokens += inputTokens;
  _totalOutputTokens += outputTokens;
}

/** Return a snapshot of current telemetry state (does not flush). */
export function getTelemetrySnapshot(): TelemetrySnapshot {
  const sorted = [..._latenciesMs].sort((a, b) => a - b);
  const pct = (p: number) => {
    if (sorted.length === 0) return 0;
    return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
  };
  return {
    totalInputTokens: _totalInputTokens,
    totalOutputTokens: _totalOutputTokens,
    cacheHits: _cacheHits,
    cacheMisses: _cacheMisses,
    toolCallCount: _latenciesMs.length,
    p50LatencyMs: pct(50),
    p99LatencyMs: pct(99),
  };
}

/**
 * Explicitly emit the telemetry snapshot to the configured sink.
 * Useful for testing or early-flush scenarios; normally called via the exit handler.
 */
export function emitTelemetry(): void {
  _emitSync();
}

/** Whether telemetry is currently enabled. */
export function isTelemetryEnabled(): boolean {
  return _enabled;
}

/**
 * Compute the nth percentile (0–100) of a sorted or unsorted array.
 * Returns 0 for empty arrays.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function _emitSync(): void {
  try {
    const snapshot = getTelemetrySnapshot();
    const json = JSON.stringify(snapshot) + '\n';
    const target = _telemetryFile;
    if (target) {
      try {
        mkdirSync(dirname(target), { recursive: true });
      } catch {
        // ignore mkdir failures; writeFileSync will surface any real problem
      }
      writeFileSync(target, json, 'utf8');
    } else {
      process.stderr.write(json);
    }
  } catch {
    // Telemetry failures must never crash the process.
  }
}

/** Reset all state. For use in tests only — do not call in production code. */
export function _resetTelemetry(): void {
  _enabled = false;
  _telemetryFile = null;
  _totalInputTokens = 0;
  _totalOutputTokens = 0;
  _cacheHits = 0;
  _cacheMisses = 0;
  _latenciesMs = [];
  _exitHandlerRegistered = false;
  stopOtelExport();
  _otelStartTimeMs = 0;
}

// ─── OpenTelemetry export ────────────────────────────────────────────────────

export interface OtelExportConfig {
  enabled: boolean;
  /** OTLP/HTTP endpoint base URL. Also read from OTEL_EXPORTER_OTLP_ENDPOINT. */
  endpoint?: string | null;
  /** Extra HTTP headers (e.g. auth). Also parsed from OTEL_EXPORTER_OTLP_HEADERS. */
  headers?: Record<string, string>;
  /** Export interval in ms. Also read from OTEL_METRIC_EXPORT_INTERVAL. Default 60000. */
  exportIntervalMs?: number | null;
  /** OTEL service.name attribute. Also read from OTEL_SERVICE_NAME. Default "heimdall". */
  serviceName?: string | null;
}

let _otelInterval: ReturnType<typeof setInterval> | null = null;
let _otelStartTimeMs = 0;

/**
 * Parse the OTEL_EXPORTER_OTLP_HEADERS format: "key=value,key2=value2".
 * URL-decoded per the OpenTelemetry spec.
 */
export function parseOtelHeaders(raw: string): Record<string, string> {
  if (!raw.trim()) return {};
  const result: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const rawKey = pair.slice(0, eq).trim();
    const rawValue = pair.slice(eq + 1).trim();
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(rawKey);
      value = decodeURIComponent(rawValue);
    } catch {
      key = rawKey;
      value = rawValue;
    }
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Convert milliseconds-since-epoch to a nanosecond string.
 * OTLP uses string-encoded int64 for timestamps. String concatenation avoids
 * floating-point precision loss at modern Unix timestamps (> Number.MAX_SAFE_INTEGER
 * when expressed in nanoseconds).
 */
function msToNanoStr(ms: number): string {
  if (ms === 0) return '0';
  const secs = Math.floor(ms / 1000);
  const remainMs = ms % 1000;
  return secs.toString() + (remainMs * 1_000_000).toString().padStart(9, '0');
}

/**
 * Build an OTLP/HTTP JSON metrics payload from the current snapshot.
 * startTimeMs and nowTimeMs are Unix timestamps in milliseconds.
 */
export function buildOtlpPayload(
  snapshot: TelemetrySnapshot,
  serviceName: string,
  startTimeMs: number,
  nowTimeMs: number,
): object {
  const startNs = msToNanoStr(startTimeMs);
  const nowNs = msToNanoStr(nowTimeMs);

  function sumMetric(name: string, description: string, unit: string, value: number) {
    return {
      name,
      description,
      unit,
      sum: {
        dataPoints: [{
          startTimeUnixNano: startNs,
          timeUnixNano: nowNs,
          asInt: Math.round(value),
          attributes: [],
        }],
        aggregationTemporality: 2, // AGGREGATION_TEMPORALITY_CUMULATIVE
        isMonotonic: true,
      },
    };
  }

  function gaugeMetric(name: string, description: string, unit: string, value: number) {
    return {
      name,
      description,
      unit,
      gauge: {
        dataPoints: [{
          startTimeUnixNano: startNs,
          timeUnixNano: nowNs,
          asDouble: value,
          attributes: [],
        }],
      },
    };
  }

  return {
    resourceMetrics: [{
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: serviceName } }],
      },
      scopeMetrics: [{
        scope: { name: 'heimdall/telemetry', version: '1.0.0' },
        metrics: [
          sumMetric('heimdall.tool.calls', 'Total tool calls', '{calls}', snapshot.toolCallCount),
          sumMetric('heimdall.kubectl.cache_hits', 'kubectl cache hits', '{hits}', snapshot.cacheHits),
          sumMetric('heimdall.kubectl.cache_misses', 'kubectl cache misses', '{misses}', snapshot.cacheMisses),
          sumMetric('heimdall.llm.input_tokens', 'LLM input tokens consumed', '{tokens}', snapshot.totalInputTokens),
          sumMetric('heimdall.llm.output_tokens', 'LLM output tokens produced', '{tokens}', snapshot.totalOutputTokens),
          gaugeMetric('heimdall.tool.latency_p50_ms', 'P50 tool-call latency', 'ms', snapshot.p50LatencyMs),
          gaugeMetric('heimdall.tool.latency_p99_ms', 'P99 tool-call latency', 'ms', snapshot.p99LatencyMs),
        ],
      }],
    }],
  };
}

/**
 * Push a metrics snapshot to an OTLP/HTTP JSON endpoint.
 * Failures are logged to stderr and never propagate.
 */
export async function pushOtlpMetrics(
  endpoint: string,
  headers: Record<string, string>,
  snapshot: TelemetrySnapshot,
  serviceName: string,
  startTimeMs: number,
  nowTimeMs: number,
): Promise<void> {
  const payload = buildOtlpPayload(snapshot, serviceName, startTimeMs, nowTimeMs);
  const url = endpoint.endsWith('/') ? `${endpoint}v1/metrics` : `${endpoint}/v1/metrics`;
  try {
    await withTimeout(10_000, async (signal) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(payload),
        signal,
      });
      if (!res.ok) {
        process.stderr.write(`[heimdall-otel] OTLP push failed: HTTP ${res.status}\n`);
      }
      await res.text(); // drain body to release the socket
    });
  } catch (err) {
    process.stderr.write(`[heimdall-otel] OTLP push error: ${String(err)}\n`);
  }
}

/**
 * Start periodic OTLP metric export.
 * Resolves configuration from both the provided config object and standard
 * OTEL env vars (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS,
 * OTEL_METRIC_EXPORT_INTERVAL, OTEL_SERVICE_NAME).
 * No-op when already running; call stopOtelExport() first to reconfigure.
 */
export function startOtelExport(config: OtelExportConfig): void {
  if (_otelInterval !== null) return;

  const endpoint =
    config.endpoint?.trim() ||
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim() ||
    null;

  if (!config.enabled && !endpoint) return;

  if (!endpoint) {
    process.stderr.write(
      '[heimdall-otel] OTEL enabled but no endpoint set ' +
      '(set OTEL_EXPORTER_OTLP_ENDPOINT or otel.endpoint in config)\n',
    );
    return;
  }

  const envHeaders = parseOtelHeaders(process.env['OTEL_EXPORTER_OTLP_HEADERS'] ?? '');
  const headers: Record<string, string> = { ...envHeaders, ...(config.headers ?? {}) };

  const rawInterval =
    config.exportIntervalMs ??
    parseInt(process.env['OTEL_METRIC_EXPORT_INTERVAL'] ?? '', 10);
  const intervalMs = Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 60_000;

  const serviceName =
    config.serviceName?.trim() ||
    process.env['OTEL_SERVICE_NAME']?.trim() ||
    'heimdall';

  _otelStartTimeMs = Date.now();

  _otelInterval = setInterval(() => {
    const snap = getTelemetrySnapshot();
    void pushOtlpMetrics(endpoint, headers, snap, serviceName, _otelStartTimeMs, Date.now());
  }, intervalMs);

  // Unref so the interval doesn't prevent Node from exiting naturally.
  if (typeof (_otelInterval as unknown as { unref?: () => void }).unref === 'function') {
    (_otelInterval as unknown as { unref: () => void }).unref();
  }
}

/** Stop the periodic OTLP export interval. */
export function stopOtelExport(): void {
  if (_otelInterval !== null) {
    clearInterval(_otelInterval);
    _otelInterval = null;
  }
}

/**
 * Render current telemetry as a Prometheus exposition format string.
 * Suitable for serving from GET /metrics.
 */
export function formatPrometheusMetrics(
  snapshot: TelemetrySnapshot,
  serviceName = 'heimdall',
): string {
  const escapedService = serviceName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const label = `{service="${escapedService}"}`;
  const lines: string[] = [];

  const metrics: Array<[string, 'counter' | 'gauge', string, number]> = [
    ['heimdall_tool_calls_total', 'counter', 'Total tool calls executed', snapshot.toolCallCount],
    ['heimdall_kubectl_cache_hits_total', 'counter', 'Total kubectl cache hits', snapshot.cacheHits],
    ['heimdall_kubectl_cache_misses_total', 'counter', 'Total kubectl cache misses', snapshot.cacheMisses],
    ['heimdall_llm_input_tokens_total', 'counter', 'Total LLM input tokens consumed', snapshot.totalInputTokens],
    ['heimdall_llm_output_tokens_total', 'counter', 'Total LLM output tokens produced', snapshot.totalOutputTokens],
    ['heimdall_tool_latency_p50_milliseconds', 'gauge', 'P50 tool-call latency in milliseconds', snapshot.p50LatencyMs],
    ['heimdall_tool_latency_p99_milliseconds', 'gauge', 'P99 tool-call latency in milliseconds', snapshot.p99LatencyMs],
  ];

  for (const [name, type, help, value] of metrics) {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    lines.push(`${name}${label} ${value}`);
  }

  return lines.join('\n') + '\n';
}
