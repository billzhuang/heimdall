/**
 * Lightweight in-process telemetry tracker for Heimdall.
 *
 * Accumulates tool-call latencies, kubectl cache hit/miss counts, and token
 * usage in process-level singleton state. When enabled (via config or
 * HEIMDALL_TELEMETRY_FILE env var), emits a JSON summary blob to stderr or a
 * file at process exit.
 *
 * All recording functions are synchronous no-ops when disabled, so they add
 * no measurable overhead to the hot path.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
}
