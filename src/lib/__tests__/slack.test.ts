import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  sendSlackNotification,
  meetsMinSeverity,
  MAX_SLACK_TEXT_CHARS,
  MAX_BULLET_LINES,
  MAX_SUGGESTED_COMMANDS,
  type SlackConfig,
} from '../slack.ts';
import type { OneShotFinding } from '../format-output.ts';

const BASE_CONFIG: SlackConfig = {
  webhookUrl: 'https://hooks.slack.com/services/TEST/TEST/TEST',
  minSeverity: 'info',
  timeoutMs: 5_000,
};

const CRITICAL_FINDING: OneShotFinding = {
  summary: '- api pod is OOMKilled\n- memory limit too low\n- HPA cannot scale further',
  answer: 'The api pod was OOMKilled. Increase the memory limit or reduce concurrent requests.',
  severity: 'critical',
  suggestedCommands: ['kubectl describe pod api-xyz -n prod', 'kubectl top pod -n prod'],
  model: 'anthropic/claude-sonnet-4-6',
};

const INFO_FINDING: OneShotFinding = {
  summary: '- All pods healthy',
  answer: 'No issues detected.',
  severity: 'info',
  suggestedCommands: [],
};

function mockFetch(status = 200, body = 'ok'): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    text: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// meetsMinSeverity
// ---------------------------------------------------------------------------

describe('meetsMinSeverity', () => {
  it('info meets info', () => expect(meetsMinSeverity('info', 'info')).toBe(true));
  it('warning meets info', () => expect(meetsMinSeverity('warning', 'info')).toBe(true));
  it('critical meets warning', () => expect(meetsMinSeverity('critical', 'warning')).toBe(true));
  it('info does not meet warning', () => expect(meetsMinSeverity('info', 'warning')).toBe(false));
  it('info does not meet critical', () => expect(meetsMinSeverity('info', 'critical')).toBe(false));
  it('warning does not meet critical', () =>
    expect(meetsMinSeverity('warning', 'critical')).toBe(false));

  it('unknown severity uses 0 as fallback and can meet info', () =>
    expect(meetsMinSeverity('unknown', 'info')).toBe(true));

  it('unknown minSeverity uses 0 as fallback and is met by any known severity', () =>
    expect(meetsMinSeverity('info', 'custom-level')).toBe(true));
});

// ---------------------------------------------------------------------------
// sendSlackNotification — happy path
// ---------------------------------------------------------------------------

describe('sendSlackNotification — happy path', () => {
  it('POSTs to the webhook URL', async () => {
    const fetch = mockFetch();
    await sendSlackNotification(CRITICAL_FINDING, BASE_CONFIG);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(BASE_CONFIG.webhookUrl);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('sends valid JSON body with blocks array', async () => {
    const fetch = mockFetch();
    await sendSlackNotification(CRITICAL_FINDING, BASE_CONFIG);
    const body = JSON.parse(fetch.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(Array.isArray(body['blocks'])).toBe(true);
    const blocks = body['blocks'] as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({ type: 'header' });
  });

  it('includes severity emoji in header', async () => {
    const fetch = mockFetch();
    await sendSlackNotification(CRITICAL_FINDING, BASE_CONFIG);
    const body = JSON.parse(fetch.mock.calls[0][1].body as string) as Record<string, unknown>;
    const blocks = body['blocks'] as Array<Record<string, unknown>>;
    const headerText = (blocks[0] as Record<string, unknown>)['text'] as Record<string, unknown>;
    expect(String(headerText['text'])).toContain(':rotating_light:');
  });

  it('includes suggested commands in the payload', async () => {
    const fetch = mockFetch();
    await sendSlackNotification(CRITICAL_FINDING, BASE_CONFIG);
    const bodyStr = fetch.mock.calls[0][1].body as string;
    expect(bodyStr).toContain('kubectl describe pod');
  });

  it('includes optional channel when provided', async () => {
    const fetch = mockFetch();
    await sendSlackNotification(CRITICAL_FINDING, { ...BASE_CONFIG, channel: '#sre-alerts' });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(body['channel']).toBe('#sre-alerts');
  });

  it('omits channel key when not provided', async () => {
    const fetch = mockFetch();
    await sendSlackNotification(CRITICAL_FINDING, BASE_CONFIG);
    const body = JSON.parse(fetch.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('channel');
  });
});

// ---------------------------------------------------------------------------
// sendSlackNotification — minSeverity filtering
// ---------------------------------------------------------------------------

describe('sendSlackNotification — minSeverity filtering', () => {
  it('skips info findings when minSeverity is warning', async () => {
    const fetch = mockFetch();
    await sendSlackNotification(INFO_FINDING, { ...BASE_CONFIG, minSeverity: 'warning' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips warning findings when minSeverity is critical', async () => {
    const fetch = mockFetch();
    const warningFinding: OneShotFinding = {
      ...CRITICAL_FINDING,
      severity: 'warning',
    };
    await sendSlackNotification(warningFinding, { ...BASE_CONFIG, minSeverity: 'critical' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts when severity meets minSeverity exactly', async () => {
    const fetch = mockFetch();
    await sendSlackNotification(INFO_FINDING, { ...BASE_CONFIG, minSeverity: 'info' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('uses the fallback :mag: emoji when severity is not in SEVERITY_EMOJI', async () => {
    const fetch = mockFetch();
    const unknownSeverityFinding: OneShotFinding = { ...CRITICAL_FINDING, severity: 'debug' };
    await sendSlackNotification(unknownSeverityFinding, { ...BASE_CONFIG, minSeverity: 'info' });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string) as Record<string, unknown>;
    const blocks = body['blocks'] as Array<Record<string, unknown>>;
    const headerText = (blocks[0] as Record<string, unknown>)['text'] as Record<string, unknown>;
    expect(String(headerText['text'])).toContain(':mag:');
  });
});

// ---------------------------------------------------------------------------
// sendSlackNotification — error handling (non-fatal)
// ---------------------------------------------------------------------------

describe('sendSlackNotification — error handling', () => {
  it('does not throw on non-2xx response', async () => {
    mockFetch(500, 'internal_error');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      sendSlackNotification(CRITICAL_FINDING, BASE_CONFIG),
    ).resolves.toBeUndefined();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'));
  });

  it('does not throw on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      sendSlackNotification(CRITICAL_FINDING, BASE_CONFIG),
    ).resolves.toBeUndefined();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('network failure'));
  });

  it('does not throw on AbortError (timeout)', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortErr));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      sendSlackNotification(CRITICAL_FINDING, { ...BASE_CONFIG, timeoutMs: 1 }),
    ).resolves.toBeUndefined();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });
});

// ---------------------------------------------------------------------------
// sendSlackNotification — finding with no suggested commands
// ---------------------------------------------------------------------------

describe('sendSlackNotification — no suggestedCommands', () => {
  it('does not include commands block when suggestedCommands is empty', async () => {
    const fetch = mockFetch();
    await sendSlackNotification(INFO_FINDING, BASE_CONFIG);
    const body = JSON.parse(fetch.mock.calls[0][1].body as string) as Record<string, unknown>;
    const blocks = body['blocks'] as Array<Record<string, unknown>>;
    const texts = blocks.map(
      (b) => ((b['text'] as Record<string, unknown>)?.['text'] as string) ?? '',
    );
    expect(texts.some((t) => t.includes('Suggested commands'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendSlackNotification — buildBlockKitPayload edge cases
// ---------------------------------------------------------------------------

describe('sendSlackNotification — buildBlockKitPayload edge cases', () => {
  it('omits "Key findings" block when summary has no bullet lines', async () => {
    const fetch = mockFetch();
    const finding: OneShotFinding = { ...CRITICAL_FINDING, summary: 'All systems operational' };
    await sendSlackNotification(finding, BASE_CONFIG);
    const body = JSON.parse(fetch.mock.calls[0][1].body as string) as Record<string, unknown>;
    const blocks = body['blocks'] as Array<Record<string, unknown>>;
    const texts = blocks.map((b) => JSON.stringify(b));
    expect(texts.some((t) => t.includes('Key findings'))).toBe(false);
  });

  it('uses placeholder text when answer is empty', async () => {
    const fetch = mockFetch();
    await sendSlackNotification({ ...CRITICAL_FINDING, answer: '' }, BASE_CONFIG);
    const bodyStr = fetch.mock.calls[0][1].body as string;
    expect(bodyStr).toContain('_No answer provided._');
  });

  it('falls back to :mag: emoji for unknown severity', async () => {
    const fetch = mockFetch();
    await sendSlackNotification(
      { ...CRITICAL_FINDING, severity: 'debug' } as unknown as OneShotFinding,
      BASE_CONFIG,
    );
    const bodyStr = fetch.mock.calls[0][1].body as string;
    expect(bodyStr).toContain(':mag:');
  });

  it('handles response.text() rejection on non-2xx gracefully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: () => Promise.reject(new Error('read failed')),
      }),
    );
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(sendSlackNotification(CRITICAL_FINDING, BASE_CONFIG)).resolves.toBeUndefined();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'));
  });

  it('handles non-Error thrown by fetch via String(err)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('string error value'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(sendSlackNotification(CRITICAL_FINDING, BASE_CONFIG)).resolves.toBeUndefined();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('string error value'));
  });

  it(`truncates answer to MAX_SLACK_TEXT_CHARS (${MAX_SLACK_TEXT_CHARS}) characters`, async () => {
    const fetch = mockFetch();
    const longAnswer = 'x'.repeat(MAX_SLACK_TEXT_CHARS + 500);
    await sendSlackNotification({ ...CRITICAL_FINDING, answer: longAnswer }, BASE_CONFIG);
    const bodyStr = fetch.mock.calls[0][1].body as string;
    const payload = JSON.parse(bodyStr) as { blocks: Array<{ text?: { text: string } }> };
    const answerBlock = payload.blocks.find((b) => b.text?.text.startsWith('x'));
    expect(answerBlock?.text?.text).toHaveLength(MAX_SLACK_TEXT_CHARS);
  });

  it(`shows at most MAX_BULLET_LINES (${MAX_BULLET_LINES}) bullets from summary`, async () => {
    const fetch = mockFetch();
    const manyBullets = Array.from({ length: 10 }, (_, i) => `- bullet ${i + 1}`).join('\n');
    await sendSlackNotification({ ...CRITICAL_FINDING, summary: manyBullets }, BASE_CONFIG);
    const payload = JSON.parse(fetch.mock.calls[0][1].body as string) as {
      blocks: Array<{ text?: { text: string } }>;
    };
    const findingsBlock = payload.blocks.find((b) => b.text?.text.includes('Key findings'));
    const bulletLines = findingsBlock?.text?.text.split('\n').filter((l) => l.startsWith('-')) ?? [];
    expect(bulletLines.length).toBe(MAX_BULLET_LINES);
  });

  it(`shows at most MAX_SUGGESTED_COMMANDS (${MAX_SUGGESTED_COMMANDS}) commands`, async () => {
    const fetch = mockFetch();
    const manyCommands = Array.from({ length: 10 }, (_, i) => `kubectl get pod-${i}`);
    await sendSlackNotification({ ...CRITICAL_FINDING, suggestedCommands: manyCommands }, BASE_CONFIG);
    const payload = JSON.parse(fetch.mock.calls[0][1].body as string) as {
      blocks: Array<{ text?: { text: string } }>;
    };
    const cmdsBlock = payload.blocks.find((b) => b.text?.text.includes('Suggested commands'));
    const cmdLines = cmdsBlock?.text?.text.split('\n').filter((l) => l.startsWith('kubectl')) ?? [];
    expect(cmdLines.length).toBe(MAX_SUGGESTED_COMMANDS);
  });
});
