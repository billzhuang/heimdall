/**
 * Unit tests for serve-mode route handlers.
 *
 * Tests the Hono app routes in isolation via dependency injection — no real
 * agent subprocess is spawned. runAgentDiagnose is passed as a mock to
 * createServeApp, keeping tests fast and deterministic.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.ts', () => ({
  loadConfig: () => ({
    tools: { kubectl: true },
    server: { port: 3000, host: '127.0.0.1' },
  }),
}));

import { createServeApp } from '../../serve-mode.ts';

function makeApp(agentFn: (prompt: string, model: string) => Promise<string>) {
  return createServeApp(agentFn);
}

function makeAppWithAuth(
  agentFn: (prompt: string, model: string) => Promise<string>,
  apiKey: string,
) {
  return createServeApp(agentFn, undefined, apiKey);
}

const neverCalled = async (_prompt: string, _model: string): Promise<string> => {
  throw new Error('agent should not be called');
};

describe('createServeApp', () => {
  describe('GET /api/health', () => {
    it('returns 200 with status ok', async () => {
      const app = makeApp(neverCalled);
      const res = await app.fetch(new Request('http://localhost/api/health'));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toEqual({ status: 'ok', service: 'heimdall' });
    });
  });

  describe('GET /api/openapi.json', () => {
    it('returns 200 with a valid OpenAPI 3.1 spec', async () => {
      const app = makeApp(neverCalled);
      const res = await app.fetch(new Request('http://localhost/api/openapi.json'));
      expect(res.status).toBe(200);
      const spec = await res.json() as Record<string, unknown>;
      expect(spec['openapi']).toBe('3.1.0');
      expect(typeof spec['info']).toBe('object');
      expect(typeof spec['paths']).toBe('object');
      const paths = spec['paths'] as Record<string, unknown>;
      expect(paths['/api/health']).toBeDefined();
      expect(paths['/api/diagnose']).toBeDefined();
    });

    it('spec has diagnose endpoint with required prompt field', async () => {
      const app = makeApp(neverCalled);
      const res = await app.fetch(new Request('http://localhost/api/openapi.json'));
      const spec = await res.json() as Record<string, unknown>;
      const paths = spec['paths'] as Record<string, unknown>;
      const diagnose = paths['/api/diagnose'] as Record<string, unknown>;
      const post = diagnose['post'] as Record<string, unknown>;
      const reqBody = post['requestBody'] as Record<string, unknown>;
      const content = reqBody['content'] as Record<string, unknown>;
      const jsonContent = content['application/json'] as Record<string, unknown>;
      const schema = jsonContent['schema'] as Record<string, unknown>;
      const required = schema['required'] as string[];
      expect(required).toContain('prompt');
    });
  });

  describe('POST /api/diagnose', () => {
    it('returns 400 when body is not valid JSON', async () => {
      const app = makeApp(neverCalled);
      const res = await app.fetch(
        new Request('http://localhost/api/diagnose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not json',
        }),
      );
      expect(res.status).toBe(400);
    });

    it('returns 400 when prompt is missing', async () => {
      const app = makeApp(neverCalled);
      const res = await app.fetch(
        new Request('http://localhost/api/diagnose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ namespace: 'prod' }),
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(typeof body['error']).toBe('string');
    });

    it('returns 400 when prompt is empty string', async () => {
      const app = makeApp(neverCalled);
      const res = await app.fetch(
        new Request('http://localhost/api/diagnose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: '   ' }),
        }),
      );
      expect(res.status).toBe(400);
    });

    it('returns 400 when model has invalid format', async () => {
      const app = makeApp(neverCalled);
      const res = await app.fetch(
        new Request('http://localhost/api/diagnose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'why are pods failing?', model: 'invalid-no-slash' }),
        }),
      );
      expect(res.status).toBe(400);
    });

    it('invokes the agent and returns JSON finding on success', async () => {
      const mockFinding = {
        summary: 'Pod is crash-looping',
        answer: 'The pod is failing due to OOM.',
        severity: 'warning',
        suggestedCommands: ['kubectl describe pod api -n prod'],
        model: 'anthropic/claude-sonnet-4-6',
      };
      const agentFn = vi.fn().mockResolvedValueOnce(JSON.stringify(mockFinding) + '\n');
      const app = makeApp(agentFn);

      const res = await app.fetch(
        new Request('http://localhost/api/diagnose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'Why is my pod crash-looping?' }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body['summary']).toBe('Pod is crash-looping');
      expect(body['severity']).toBe('warning');
    });

    it('appends namespace scope to prompt when namespace is provided', async () => {
      const mockFinding = {
        summary: 'All good',
        answer: 'Cluster healthy.',
        severity: 'info',
        suggestedCommands: [],
      };
      const agentFn = vi.fn().mockResolvedValueOnce(JSON.stringify(mockFinding) + '\n');
      const app = makeApp(agentFn);

      await app.fetch(
        new Request('http://localhost/api/diagnose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'Check pod health', namespace: 'staging' }),
        }),
      );

      expect(agentFn).toHaveBeenCalledWith(
        expect.stringContaining('namespace "staging"'),
        expect.any(String),
      );
    });

    it('returns 500 when agent errors', async () => {
      const agentFn = vi.fn().mockRejectedValueOnce(new Error('agent timed out after 5 minutes'));
      const app = makeApp(agentFn);

      const res = await app.fetch(
        new Request('http://localhost/api/diagnose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'Check pod health' }),
        }),
      );
      expect(res.status).toBe(500);
      const body = await res.json() as Record<string, unknown>;
      expect(body['error']).toContain('agent timed out');
    });
  });
});

describe('createServeApp — API key authentication', () => {
  const SECRET = 'test-secret-key-abc123';

  describe('GET /api/health (always public)', () => {
    it('returns 200 without auth header', async () => {
      const app = makeAppWithAuth(neverCalled, SECRET);
      const res = await app.fetch(new Request('http://localhost/api/health'));
      expect(res.status).toBe(200);
    });

    it('returns 200 even with wrong auth header', async () => {
      const app = makeAppWithAuth(neverCalled, SECRET);
      const res = await app.fetch(
        new Request('http://localhost/api/health', {
          headers: { Authorization: 'Bearer wrong-key' },
        }),
      );
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/openapi.json (requires auth when key configured)', () => {
    it('returns 401 without auth header', async () => {
      const app = makeAppWithAuth(neverCalled, SECRET);
      const res = await app.fetch(new Request('http://localhost/api/openapi.json'));
      expect(res.status).toBe(401);
      const body = await res.json() as Record<string, unknown>;
      expect(body['error']).toBe('Unauthorized');
    });

    it('returns 401 with wrong key', async () => {
      const app = makeAppWithAuth(neverCalled, SECRET);
      const res = await app.fetch(
        new Request('http://localhost/api/openapi.json', {
          headers: { Authorization: 'Bearer wrong-key' },
        }),
      );
      expect(res.status).toBe(401);
    });

    it('returns 200 with correct key', async () => {
      const app = makeAppWithAuth(neverCalled, SECRET);
      const res = await app.fetch(
        new Request('http://localhost/api/openapi.json', {
          headers: { Authorization: `Bearer ${SECRET}` },
        }),
      );
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/diagnose (requires auth when key configured)', () => {
    it('returns 401 without auth header', async () => {
      const app = makeAppWithAuth(neverCalled, SECRET);
      const res = await app.fetch(
        new Request('http://localhost/api/diagnose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'Why are pods failing?' }),
        }),
      );
      expect(res.status).toBe(401);
      const body = await res.json() as Record<string, unknown>;
      expect(body['error']).toBe('Unauthorized');
    });

    it('returns 401 with malformed Authorization header (no Bearer prefix)', async () => {
      const app = makeAppWithAuth(neverCalled, SECRET);
      const res = await app.fetch(
        new Request('http://localhost/api/diagnose', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: SECRET,
          },
          body: JSON.stringify({ prompt: 'Why are pods failing?' }),
        }),
      );
      expect(res.status).toBe(401);
    });

    it('returns 401 with wrong key', async () => {
      const app = makeAppWithAuth(neverCalled, SECRET);
      const res = await app.fetch(
        new Request('http://localhost/api/diagnose', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer wrong-key',
          },
          body: JSON.stringify({ prompt: 'Why are pods failing?' }),
        }),
      );
      expect(res.status).toBe(401);
    });

    it('passes through to agent with correct key', async () => {
      const mockFinding = {
        summary: 'Pod is healthy',
        answer: 'No issues found.',
        severity: 'info',
        suggestedCommands: [],
        model: 'anthropic/claude-sonnet-4-6',
      };
      const agentFn = vi.fn().mockResolvedValueOnce(JSON.stringify(mockFinding));
      const app = makeAppWithAuth(agentFn, SECRET);

      const res = await app.fetch(
        new Request('http://localhost/api/diagnose', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${SECRET}`,
          },
          body: JSON.stringify({ prompt: 'Check pod health' }),
        }),
      );
      expect(res.status).toBe(200);
      expect(agentFn).toHaveBeenCalledOnce();
    });
  });

  describe('no apiKey — backwards compatible (no auth enforcement)', () => {
    it('/api/diagnose is accessible without Authorization header', async () => {
      const mockFinding = {
        summary: 'All good',
        answer: 'Healthy.',
        severity: 'info',
        suggestedCommands: [],
        model: 'anthropic/claude-sonnet-4-6',
      };
      const agentFn = vi.fn().mockResolvedValueOnce(JSON.stringify(mockFinding));
      const app = makeApp(agentFn);

      const res = await app.fetch(
        new Request('http://localhost/api/diagnose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'Check cluster health' }),
        }),
      );
      expect(res.status).toBe(200);
    });
  });
});
