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

import { createAgentCoreApp } from '../../agentcore-handler.ts';

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
});
