import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventSink, createEventSink, type EventSinkConfig } from '../event-sink.ts';
import type { WatchFinding } from '../watch.ts';

vi.mock('../jsonl.ts', () => ({
  appendJsonlLine: vi.fn(),
}));

import { appendJsonlLine } from '../jsonl.ts';
const mockAppendJsonlLine = vi.mocked(appendJsonlLine);

beforeEach(() => {
  vi.clearAllMocks();
});

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
    mockAppendJsonlLine.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls appendJsonlLine with the correct record shape', async () => {
    const sink = new EventSink({ filePath: '/tmp/events.jsonl' });
    const finding = makeFinding();
    await sink.write(finding);

    expect(mockAppendJsonlLine).toHaveBeenCalledOnce();
    const [record, path] = mockAppendJsonlLine.mock.calls[0] as [
      { timestamp: string; event: Record<string, string>; diagnosis: string | undefined; severity: string },
      string,
    ];
    expect(path).toBe('/tmp/events.jsonl');
    expect(record.timestamp).toBe(finding.ts);
    expect(record.event['namespace']).toBe('prod');
    expect(record.event['reason']).toBe('BackOff');
    expect(record.event['objectKind']).toBe('Pod');
    expect(record.event['objectName']).toBe('api-xyz');
    expect(record.diagnosis).toBe(finding.diagnosis);
    expect(record.severity).toBe('warning');
  });

  it('logs to stderr and continues when appendJsonlLine throws', async () => {
    mockAppendJsonlLine.mockRejectedValue(new Error('disk full'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const sink = new EventSink({ filePath: '/tmp/events.jsonl' });
    await expect(sink.write(makeFinding())).resolves.toBeUndefined();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('EventSink file error'));
    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// EventSink — webhook sink
// ---------------------------------------------------------------------------

describe('EventSink — webhook sink', () => {
  beforeEach(() => {
    mockAppendJsonlLine.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('POSTs JSON to the configured webhook URL', async () => {
    const capturedRequests: { url: string; body: unknown }[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string, opts: RequestInit) => {
      capturedRequests.push({ url, body: JSON.parse(String(opts.body)) });
      return { ok: true, text: async () => '' };
    });
    vi.stubGlobal('fetch', mockFetch);

    const sink = new EventSink({ webhookUrl: 'https://example.com/hook' });
    await sink.write(makeFinding());

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

    expect((capturedHeaders as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('logs to stderr on non-2xx response and does not throw', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '' }));

    const sink = new EventSink({ webhookUrl: 'https://example.com/hook' });
    await expect(sink.write(makeFinding())).resolves.toBeUndefined();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('503'));
    stderrSpy.mockRestore();
  });

  it('logs to stderr on fetch network error and does not throw', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const sink = new EventSink({ webhookUrl: 'https://example.com/hook' });
    await expect(sink.write(makeFinding())).resolves.toBeUndefined();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    stderrSpy.mockRestore();
  });

  it('logs to stderr on AbortError (timeout) and does not throw', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const abortErr = Object.assign(new Error('signal timed out'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortErr));

    const sink = new EventSink({ webhookUrl: 'https://example.com/hook' });
    await expect(sink.write(makeFinding())).resolves.toBeUndefined();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('AbortError'));
    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// EventSink — webhook timeout (abort path)
// ---------------------------------------------------------------------------

describe('EventSink — webhook abort timeout', () => {
  beforeEach(() => {
    mockAppendJsonlLine.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('aborts the hanging fetch after 10 seconds and logs webhook error to stderr', async () => {
    vi.useFakeTimers();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // fetch hangs forever — resolves only when the AbortController fires
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

    const sink = new EventSink({ webhookUrl: 'https://example.com/hook' });
    const writePromise = sink.write(makeFinding());

    // Fire the 10-second timeout
    await vi.advanceTimersByTimeAsync(11_000);
    await writePromise;

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('webhook error'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('AbortError'));
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
  beforeEach(() => {
    mockAppendJsonlLine.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('writes to both file and webhook when both are configured', async () => {
    const capturedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      capturedUrls.push(url as string);
      return { ok: true, text: async () => '' };
    }));

    const cfg: EventSinkConfig = {
      filePath: '/tmp/events.jsonl',
      webhookUrl: 'https://example.com/hook',
    };
    const sink = new EventSink(cfg);
    await sink.write(makeFinding());

    expect(mockAppendJsonlLine).toHaveBeenCalledOnce();
    expect(capturedUrls).toHaveLength(1);
  });
});
