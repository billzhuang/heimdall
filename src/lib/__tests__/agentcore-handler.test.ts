/**
 * Unit tests for the AWS Bedrock AgentCore runtime handler.
 *
 * Tests createAgentCoreApp in isolation via dependency injection — no real
 * agent subprocess is spawned.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.ts', () => ({
  loadConfig: () => ({
    tools: { kubectl: true },
    server: { port: 3000, host: '127.0.0.1' },
  }),
}));

import {
  createAgentCoreApp,
  parseAgentCoreRequestBody,
  buildAgentCoreResponse,
  resolveAgentCorePort,
} from '../../agentcore-handler.ts';
import { resolveModel } from '../model.ts';
import type { OneShotFinding } from '../format-output.ts';

const neverCalled = async (_prompt: string, _model: string): Promise<string> => {
  throw new Error('agent should not be called');
};

const MOCK_FINDING = {
  summary: 'OOM kill on api pod',
  answer: 'The api pod was OOM-killed due to a memory limit of 256Mi.',
  severity: 'critical',
  suggestedCommands: ['kubectl describe pod api -n prod'],
  model: 'anthropic/claude-sonnet-4-6',
  causalChain: ['memory pressure', 'OOM kill'],
  evidence: { 'kubectl describe pod api': 'OOMKilled' },
  validityScore: 0.9,
  remediationSteps: ['Increase memory limit'],
};

describe('createAgentCoreApp — GET /ping', () => {
  it('returns 200 OK for the health check', async () => {
    const app = createAgentCoreApp(neverCalled);
    const res = await app.fetch(new Request('http://localhost/ping'));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('OK');
  });

  it('does not invoke the agent for /ping', async () => {
    const agentFn = vi.fn();
    const app = createAgentCoreApp(agentFn);
    await app.fetch(new Request('http://localhost/ping'));
    expect(agentFn).not.toHaveBeenCalled();
  });
});

describe('createAgentCoreApp — POST /invocations', () => {
  it('returns 400 when body is not valid JSON', async () => {
    const app = createAgentCoreApp(neverCalled);
    const res = await app.fetch(
      new Request('http://localhost/invocations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body['error']).toBe('string');
  });

  it('returns 400 when inputText is missing', async () => {
    const app = createAgentCoreApp(neverCalled);
    const res = await app.fetch(
      new Request('http://localhost/invocations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'abc' }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body['error']).toContain('inputText');
  });

  it('returns 400 when inputText is blank', async () => {
    const app = createAgentCoreApp(neverCalled);
    const res = await app.fetch(
      new Request('http://localhost/invocations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputText: '   ' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is an array', async () => {
    const app = createAgentCoreApp(neverCalled);
    const res = await app.fetch(
      new Request('http://localhost/invocations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ inputText: 'why?' }]),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('calls agent with inputText and returns outputText on success', async () => {
    const agentFn = vi.fn().mockResolvedValueOnce(JSON.stringify(MOCK_FINDING));
    const app = createAgentCoreApp(agentFn);

    const res = await app.fetch(
      new Request('http://localhost/invocations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputText: 'Why is my api pod crash-looping?' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['outputText']).toBe(MOCK_FINDING.answer);
    expect(agentFn).toHaveBeenCalledWith(
      'Why is my api pod crash-looping?',
      expect.any(String),
    );
  });

  it('passes sessionId through in the response', async () => {
    const agentFn = vi.fn().mockResolvedValueOnce(JSON.stringify(MOCK_FINDING));
    const app = createAgentCoreApp(agentFn);

    const res = await app.fetch(
      new Request('http://localhost/invocations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputText: 'Check cluster health',
          sessionId: 'session-abc-123',
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['sessionId']).toBe('session-abc-123');
  });

  it('embeds structured finding in sessionAttributes', async () => {
    const agentFn = vi.fn().mockResolvedValueOnce(JSON.stringify(MOCK_FINDING));
    const app = createAgentCoreApp(agentFn);

    const res = await app.fetch(
      new Request('http://localhost/invocations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputText: 'Check cluster health' }),
      }),
    );
    const body = await res.json() as Record<string, unknown>;
    const attrs = body['sessionAttributes'] as Record<string, string>;
    expect(typeof attrs['heimdall_finding']).toBe('string');
    const finding = JSON.parse(attrs['heimdall_finding']) as Record<string, unknown>;
    expect(finding['severity']).toBe('critical');
    expect(attrs['heimdall_severity']).toBe('critical');
    expect(attrs['heimdall_validity_score']).toBe('0.9');
  });

  it('merges caller sessionAttributes with heimdall output attributes', async () => {
    const agentFn = vi.fn().mockResolvedValueOnce(JSON.stringify(MOCK_FINDING));
    const app = createAgentCoreApp(agentFn);

    const res = await app.fetch(
      new Request('http://localhost/invocations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputText: 'Check cluster',
          sessionAttributes: { caller_id: 'ci-pipeline-42' },
        }),
      }),
    );
    const body = await res.json() as Record<string, unknown>;
    const attrs = body['sessionAttributes'] as Record<string, string>;
    expect(attrs['caller_id']).toBe('ci-pipeline-42');
    expect(typeof attrs['heimdall_finding']).toBe('string');
  });

  it('returns 500 when agent throws', async () => {
    const agentFn = vi.fn().mockRejectedValueOnce(new Error('agent timed out after 5 minutes'));
    const app = createAgentCoreApp(agentFn);

    const res = await app.fetch(
      new Request('http://localhost/invocations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputText: 'Check cluster health' }),
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    expect(body['error']).toContain('agent timed out');
  });

  it('returns 500 when agent produces no output', async () => {
    const agentFn = vi.fn().mockResolvedValueOnce('   ');
    const app = createAgentCoreApp(agentFn);

    const res = await app.fetch(
      new Request('http://localhost/invocations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputText: 'Check cluster health' }),
      }),
    );
    expect(res.status).toBe(500);
  });

  it('uses the defaultModel passed to createAgentCoreApp', async () => {
    const agentFn = vi.fn().mockResolvedValueOnce(JSON.stringify(MOCK_FINDING));
    const app = createAgentCoreApp(agentFn, 'anthropic/claude-haiku-4-5-20251001');

    await app.fetch(
      new Request('http://localhost/invocations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputText: 'Check cluster health' }),
      }),
    );
    expect(agentFn).toHaveBeenCalledWith(
      'Check cluster health',
      'anthropic/claude-haiku-4-5-20251001',
    );
  });

  it('falls back to the default model when defaultModel is an invalid format', async () => {
    const agentFn = vi.fn().mockResolvedValueOnce(JSON.stringify(MOCK_FINDING));
    const app = createAgentCoreApp(agentFn, 'invalid-no-slash');

    await app.fetch(
      new Request('http://localhost/invocations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputText: 'Check cluster health' }),
      }),
    );
    expect(agentFn).toHaveBeenCalledWith('Check cluster health', resolveModel(undefined));
  });
});

describe('resolveAgentCorePort', () => {
  it('returns the default port when AGENTCORE_PORT is unset', () => {
    expect(resolveAgentCorePort(undefined)).toEqual({ port: 8080 });
  });

  it('parses a valid AGENTCORE_PORT', () => {
    expect(resolveAgentCorePort('9090')).toEqual({ port: 9090 });
  });

  it('returns a friendly error instead of NaN for a non-numeric AGENTCORE_PORT', () => {
    expect(resolveAgentCorePort('not-a-port')).toEqual({
      errorMessage: 'Error: AGENTCORE_PORT must be an integer between 1 and 65535, got "not-a-port"\n',
    });
  });

  it('returns a friendly error for an out-of-range AGENTCORE_PORT', () => {
    expect(resolveAgentCorePort('99999')).toEqual({
      errorMessage: 'Error: AGENTCORE_PORT must be an integer between 1 and 65535, got "99999"\n',
    });
  });
});

describe('parseAgentCoreRequestBody', () => {
  it('rejects non-object bodies', () => {
    expect(parseAgentCoreRequestBody(null)).toEqual({
      ok: false,
      error: 'Invalid JSON body: expected an object',
    });
    expect(parseAgentCoreRequestBody('a string')).toEqual({
      ok: false,
      error: 'Invalid JSON body: expected an object',
    });
    expect(parseAgentCoreRequestBody(['not', 'an', 'object'])).toEqual({
      ok: false,
      error: 'Invalid JSON body: expected an object',
    });
  });

  it('rejects a missing or blank inputText', () => {
    expect(parseAgentCoreRequestBody({ sessionId: 'abc' })).toEqual({
      ok: false,
      error: '"inputText" is required and must be a non-empty string',
    });
    expect(parseAgentCoreRequestBody({ inputText: '   ' })).toEqual({
      ok: false,
      error: '"inputText" is required and must be a non-empty string',
    });
    expect(parseAgentCoreRequestBody({ inputText: 42 })).toEqual({
      ok: false,
      error: '"inputText" is required and must be a non-empty string',
    });
  });

  it('trims inputText and normalizes optional fields', () => {
    expect(parseAgentCoreRequestBody({ inputText: '  why is pod x crashing?  ' })).toEqual({
      ok: true,
      body: {
        inputText: 'why is pod x crashing?',
        sessionId: undefined,
        sessionAttributes: undefined,
      },
    });
  });

  it('passes through sessionId and sessionAttributes when valid', () => {
    expect(
      parseAgentCoreRequestBody({
        inputText: 'check cluster health',
        sessionId: 'sess-1',
        sessionAttributes: { tenant: 'acme' },
      }),
    ).toEqual({
      ok: true,
      body: {
        inputText: 'check cluster health',
        sessionId: 'sess-1',
        sessionAttributes: { tenant: 'acme' },
      },
    });
  });

  it('drops sessionId and sessionAttributes when malformed', () => {
    expect(
      parseAgentCoreRequestBody({
        inputText: 'check cluster health',
        sessionId: 123,
        sessionAttributes: ['not', 'a', 'record'],
      }),
    ).toEqual({
      ok: true,
      body: {
        inputText: 'check cluster health',
        sessionId: undefined,
        sessionAttributes: undefined,
      },
    });
  });
});

describe('buildAgentCoreResponse', () => {
  it('embeds the finding and derives severity/validity score attributes', () => {
    const resp = buildAgentCoreResponse(
      MOCK_FINDING as OneShotFinding,
      JSON.stringify(MOCK_FINDING),
      { inputText: 'why?', sessionId: 'sess-1', sessionAttributes: { tenant: 'acme' } },
    );
    expect(resp).toEqual({
      outputText: MOCK_FINDING.answer,
      sessionId: 'sess-1',
      sessionAttributes: {
        tenant: 'acme',
        heimdall_finding: JSON.stringify(MOCK_FINDING),
        heimdall_severity: 'critical',
        heimdall_validity_score: '0.9',
      },
    });
  });

  it('falls back to the raw trimmed output and default severity when the finding lacks them', () => {
    const finding = {
      ...MOCK_FINDING,
      answer: undefined,
      severity: undefined,
      validityScore: undefined,
    } as unknown as OneShotFinding;
    const resp = buildAgentCoreResponse(finding, 'raw fallback text', { inputText: 'why?' });
    expect(resp.outputText).toBe('raw fallback text');
    expect(resp.sessionAttributes?.['heimdall_severity']).toBe('info');
    expect(resp.sessionAttributes?.['heimdall_validity_score']).toBe('');
  });

  it('handles a null or undefined finding gracefully instead of throwing', () => {
    for (const finding of [null, undefined]) {
      const resp = buildAgentCoreResponse(finding, 'raw fallback text', { inputText: 'why?' });
      expect(resp.outputText).toBe('raw fallback text');
      expect(resp.sessionAttributes?.['heimdall_severity']).toBe('info');
      expect(resp.sessionAttributes?.['heimdall_validity_score']).toBe('');
    }
  });
});
