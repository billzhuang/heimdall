import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventSink, createEventSink, type EventSinkConfig } from '../event-sink.ts';
import type { WatchFinding } from '../watch.ts';

function makeFinding(overrides: Partial<WatchFinding> = {}): WatchFinding {
  return {
    ts: '2026-06-21T00:00:00.000Z',
    namespace: 'prod',
    reason: 'BackOff',
    objectKind: 'Pod',
    objectName: 'api-xyz',
    message: 'Back-off restarting failed container',
    diagnosis: 'The container is crashing on startup.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createEventSink
// ---------------------------------------------------------------------------

describe('createEventSink', () => {
  it('returns null when config is null', () => {
    expect(createEventSink(null)).toBeNull();
  });

  it('returns null when config is undefined', () => {
    expect(createEventSink(undefined)).toBeNull();
  });

  it('returns null when all sink fields are absent', () => {
    expect(createEventSink({})).toBeNull();
  });

  it('returns null when all sink fields are null', () => {
    expect(createEventSink({ filePath: null, webhookUrl: null, s3Bucket: null })).toBeNull();
  });

  it('returns an EventSink when filePath is set', () => {
    expect(createEventSink({ filePath: '/tmp/events.jsonl' })).toBeInstanceOf(EventSink);
  });

  it('returns an EventSink when webhookUrl is set', () => {
    expect(createEventSink({ webhookUrl: 'https://example.com/hook' })).toBeInstanceOf(EventSink);
  });

  it('returns an EventSink when s3Bucket is set', () => {
    expect(createEventSink({ s3Bucket: 'my-bucket' })).toBeInstanceOf(EventSink);
  });
});

// ---------------------------------------------------------------------------
// EventSink — file sink
// ---------------------------------------------------------------------------

describe('EventSink — file sink', () => {
  beforeEach(() => {
    vi.doMock('node:fs', () => ({ appendFileSync: vi.fn() }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a JSONL record with the correct shape', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'heimdall-test-'));
    const filePath = join(tmpDir, 'events.jsonl');
    try {
      const sink = new EventSink({ filePath });
      const finding = makeFinding();
      await sink.write(finding);

      const content = await readFile(filePath, 'utf-8');
      const record = JSON.parse(content.trimEnd());
      expect(record.timestamp).toBe(finding.ts);
      expect(record.event.namespace).toBe('prod');
      expect(record.event.reason).toBe('BackOff');
      expect(record.event.objectKind).toBe('Pod');
      expect(record.event.objectName).toBe('api-xyz');
      expect(record.diagnosis).toBe(finding.diagnosis);
      expect(record.severity).toBe('warning');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('appends a newline after the JSON', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'heimdall-test-'));
    const filePath = join(tmpDir, 'events.jsonl');
    try {
      const sink = new EventSink({ filePath });
      await sink.write(makeFinding());

      const content = await readFile(filePath, 'utf-8');
      expect(content).toMatch(/\n$/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('logs to stderr and continues when appendFileSync throws', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const origModule = await import('node:fs');
    const spy = vi.spyOn(origModule, 'appendFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });

    const sink = new EventSink({ filePath: '/test/events.jsonl' });
    await expect(sink.write(makeFinding())).resolves.toBeUndefined();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('EventSink file error'));
    spy.mockRestore();
    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// EventSink — webhook sink
// ---------------------------------------------------------------------------

describe('EventSink — webhook sink', () => {
  it('POSTs JSON to the configured webhook URL', async () => {
    const capturedRequests: { url: string; body: unknown }[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string, opts: RequestInit) => {
      capturedRequests.push({ url, body: JSON.parse(String(opts.body)) });
      return { ok: true, text: async () => '' };
    });
    vi.stubGlobal('fetch', mockFetch);

    const sink = new EventSink({ webhookUrl: 'https://example.com/hook' });
    await sink.write(makeFinding());
    vi.unstubAllGlobals();

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toBe('https://example.com/hook');
    expect(capturedRequests[0].body).toMatchObject({
      timestamp: '2026-06-21T00:00:00.000Z',
      event: { namespace: 'prod', reason: 'BackOff' },
      severity: 'warning',
    });
  });

  it('sends Content-Type: application/json', async () => {
    let capturedHeaders: Headers | Record<string, string> | undefined;
    const mockFetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      capturedHeaders = opts.headers as Record<string, string>;
      return { ok: true, text: async () => '' };
    });
    vi.stubGlobal('fetch', mockFetch);

    const sink = new EventSink({ webhookUrl: 'https://example.com/hook' });
    await sink.write(makeFinding());
    vi.unstubAllGlobals();

    expect((capturedHeaders as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('logs to stderr on non-2xx response and does not throw', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '' }));

    const sink = new EventSink({ webhookUrl: 'https://example.com/hook' });
    await expect(sink.write(makeFinding())).resolves.toBeUndefined();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('503'));
    vi.unstubAllGlobals();
    stderrSpy.mockRestore();
  });

  it('logs to stderr on fetch network error and does not throw', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const sink = new EventSink({ webhookUrl: 'https://example.com/hook' });
    await expect(sink.write(makeFinding())).resolves.toBeUndefined();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    vi.unstubAllGlobals();
    stderrSpy.mockRestore();
  });

  it('logs to stderr on AbortError (timeout) and does not throw', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const abortErr = Object.assign(new Error('signal timed out'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortErr));

    const sink = new EventSink({ webhookUrl: 'https://example.com/hook' });
    await expect(sink.write(makeFinding())).resolves.toBeUndefined();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('AbortError'));
    vi.unstubAllGlobals();
    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// EventSink — s3Bucket sink (reserved)
// ---------------------------------------------------------------------------

describe('EventSink — s3Bucket sink', () => {
  it('logs a not-implemented message to stderr for s3Bucket', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const sink = new EventSink({ s3Bucket: 'my-events-bucket' });
    await sink.write(makeFinding());

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('s3Bucket sink is not yet implemented'),
    );
    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// EventSink — multiple sinks
// ---------------------------------------------------------------------------

describe('EventSink — multiple sinks', () => {
  it('writes to both file and webhook when both are configured', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'heimdall-test-'));
    const filePath = join(tmpDir, 'events.jsonl');

    const capturedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      capturedUrls.push(url as string);
      return { ok: true, text: async () => '' };
    }));

    try {
      const cfg: EventSinkConfig = {
        filePath,
        webhookUrl: 'https://example.com/hook',
      };
      const sink = new EventSink(cfg);
      await sink.write(makeFinding());

      const content = await readFile(filePath, 'utf-8');
      expect(content.trim().length).toBeGreaterThan(0);
      expect(capturedUrls).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
