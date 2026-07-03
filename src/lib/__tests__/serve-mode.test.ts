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

import { createServeApp, parsePortValue, parsePortArg, parseServeArgs } from '../../serve-mode.ts';

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

describe('parsePortValue', () => {
  it('accepts valid port numbers', () => {
    expect(parsePortValue('3000')).toBe(3000);
    expect(parsePortValue('1')).toBe(1);
    expect(parsePortValue('65535')).toBe(65535);
  });

  it('rejects out-of-range values', () => {
    expect(parsePortValue('0')).toBeNull();
    expect(parsePortValue('65536')).toBeNull();
    expect(parsePortValue('-1')).toBeNull();
  });

  it('rejects non-numeric input', () => {
    expect(parsePortValue('abc')).toBeNull();
    expect(parsePortValue('')).toBeNull();
  });

  it('parses a leading-integer prefix like parseInt does', () => {
    expect(parsePortValue('80.5')).toBe(80);
  });
});

describe('parsePortArg', () => {
  it('returns the port for a valid value', () => {
    expect(parsePortArg('8080', '--port')).toEqual({ port: 8080 });
  });

  it('returns a labeled error message for --port', () => {
    expect(parsePortArg('99999', '--port')).toEqual({
      errorMessage: 'Error: --port must be an integer between 1 and 65535, got "99999"\n',
    });
  });

  it('returns a labeled error message for HEIMDALL_PORT', () => {
    expect(parsePortArg('abc', 'HEIMDALL_PORT')).toEqual({
      errorMessage: 'Error: HEIMDALL_PORT must be an integer between 1 and 65535, got "abc"\n',
    });
  });
});

describe('parseServeArgs', () => {
  it('returns empty args when given no flags', () => {
    expect(parseServeArgs([])).toEqual({ kind: 'ok', args: { port: undefined, host: undefined, model: undefined } });
  });

  it('parses --port <n> (space form)', () => {
    expect(parseServeArgs(['--port', '8080'])).toEqual({
      kind: 'ok',
      args: { port: 8080, host: undefined, model: undefined },
    });
  });

  it('parses --port=<n> (equals form)', () => {
    expect(parseServeArgs(['--port=8080'])).toEqual({
      kind: 'ok',
      args: { port: 8080, host: undefined, model: undefined },
    });
  });

  it('errors when --port is missing its value', () => {
    expect(parseServeArgs(['--port'])).toEqual({
      kind: 'error',
      message: 'Error: --port requires a value\n',
    });
  });

  it('errors when --port value is out of range', () => {
    expect(parseServeArgs(['--port', '99999'])).toEqual({
      kind: 'error',
      message: 'Error: --port must be an integer between 1 and 65535, got "99999"\n',
    });
  });

  it('errors when --port=<value> is non-numeric', () => {
    expect(parseServeArgs(['--port=abc'])).toEqual({
      kind: 'error',
      message: 'Error: --port must be an integer between 1 and 65535, got "abc"\n',
    });
  });

  it('parses --host <addr> (space form)', () => {
    expect(parseServeArgs(['--host', '0.0.0.0'])).toEqual({
      kind: 'ok',
      args: { port: undefined, host: '0.0.0.0', model: undefined },
    });
  });

  it('parses --host=<addr> (equals form)', () => {
    expect(parseServeArgs(['--host=0.0.0.0'])).toEqual({
      kind: 'ok',
      args: { port: undefined, host: '0.0.0.0', model: undefined },
    });
  });

  it('parses --model <provider/model> (space form)', () => {
    expect(parseServeArgs(['--model', 'anthropic/claude-opus-4-8'])).toEqual({
      kind: 'ok',
      args: { port: undefined, host: undefined, model: 'anthropic/claude-opus-4-8' },
    });
  });

  it('parses --model=<provider/model> (equals form)', () => {
    expect(parseServeArgs(['--model=anthropic/claude-opus-4-8'])).toEqual({
      kind: 'ok',
      args: { port: undefined, host: undefined, model: 'anthropic/claude-opus-4-8' },
    });
  });

  it('parses all three flags together', () => {
    expect(
      parseServeArgs(['--port', '8080', '--host', '0.0.0.0', '--model', 'anthropic/claude-opus-4-8']),
    ).toEqual({
      kind: 'ok',
      args: { port: 8080, host: '0.0.0.0', model: 'anthropic/claude-opus-4-8' },
    });
  });

  it('returns help for -h', () => {
    expect(parseServeArgs(['-h'])).toEqual({ kind: 'help' });
  });

  it('returns help for --help', () => {
    expect(parseServeArgs(['--help'])).toEqual({ kind: 'help' });
  });

  it('errors on an unknown option', () => {
    expect(parseServeArgs(['--bogus'])).toEqual({
      kind: 'error',
      message: 'Error: unknown option: --bogus\n',
    });
  });
});

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

    it('returns 400 with malformed Authorization header (no Bearer prefix)', async () => {
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
      // RFC 6750: malformed Authorization header is a 400 Bad Request (invalid_request),
      // not 401 Unauthorized. Hono's bearerAuth() follows this correctly.
      expect(res.status).toBe(400);
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
