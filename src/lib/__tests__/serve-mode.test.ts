/**
 * Unit tests for serve-mode route handlers.
 *
 * Tests the Hono app routes in isolation via dependency injection — no real
 * agent subprocess is spawned. runAgentDiagnose is passed as a mock to
 * createServeApp, keeping tests fast and deterministic.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../config.ts', () => ({
  loadConfig: () => ({
    tools: { kubectl: true },
    server: { port: 3000, host: '127.0.0.1' },
  }),
}));

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import {
  createServeApp,
  parsePortValue,
  parsePortArg,
  parseServeArgv,
  parseDiagnoseRequestBody,
  runAgentDiagnose,
} from '../../serve-mode.ts';

// ---------------------------------------------------------------------------
// Fake child process factory for runAgentDiagnose tests
// ---------------------------------------------------------------------------

type FakeChildOptions = {
  stdoutData?: string;
  stderrData?: string;
  exitCode?: number | null;
  signal?: string | null;
  emitError?: Error;
  pid?: number;
};

function fakeChild({
  stdoutData = '',
  stderrData = '',
  exitCode = 0,
  signal = null,
  emitError,
  pid = 4242,
}: FakeChildOptions = {}) {
  const childEmitter = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  setImmediate(() => {
    if (emitError) {
      childEmitter.emit('error', emitError);
    } else {
      if (stdoutData) stdout.emit('data', Buffer.from(stdoutData));
      if (stderrData) stderr.emit('data', Buffer.from(stderrData));
      childEmitter.emit('close', exitCode, signal);
    }
  });

  return {
    pid,
    stdout,
    stderr,
    kill: () => {},
    on: childEmitter.on.bind(childEmitter),
    once: childEmitter.once.bind(childEmitter),
  } as unknown as ReturnType<typeof spawn>;
}

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

describe('runAgentDiagnose', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves with trimmed stdout on a clean exit', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ stdoutData: '  {"summary":"ok"}  \n' }),
    );
    const result = await runAgentDiagnose('why is my pod failing?', 'anthropic/claude-sonnet-4-6');
    expect(result).toBe('{"summary":"ok"}');
  });

  it('spawns the resolved binary detached with -p/--json args and HEIMDALL_MODEL set', async () => {
    let capturedArgs: string[] = [];
    let capturedOptions: Record<string, unknown> = {};
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce((_bin: string, args: string[], options: Record<string, unknown>) => {
      capturedArgs = args;
      capturedOptions = options;
      return fakeChild({ stdoutData: 'ok' });
    });
    await runAgentDiagnose('check pods', 'anthropic/claude-opus-4-8');
    expect(capturedArgs).toEqual(['-p', 'check pods', '--json']);
    expect(capturedOptions['detached']).toBe(true);
    expect((capturedOptions['env'] as NodeJS.ProcessEnv)['HEIMDALL_MODEL']).toBe('anthropic/claude-opus-4-8');
  });

  it('rejects with the exit code and stderr when the process exits non-zero', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ exitCode: 1, stderrData: 'boom' }),
    );
    await expect(runAgentDiagnose('p', 'm')).rejects.toThrow('heimdall agent exited with code 1: boom');
  });

  it('rejects with just the exit code when stderr is empty', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => fakeChild({ exitCode: 1 }));
    await expect(runAgentDiagnose('p', 'm')).rejects.toThrow('heimdall agent exited with code 1');
  });

  it('rejects with a signal-kill message when the child is killed by a signal', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ exitCode: null, signal: 'SIGKILL' }),
    );
    await expect(runAgentDiagnose('p', 'm')).rejects.toThrow('heimdall agent killed by signal SIGKILL');
  });

  it('rejects when spawn emits an error event', async () => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      fakeChild({ emitError: new Error('spawn ENOENT') }),
    );
    await expect(runAgentDiagnose('p', 'm')).rejects.toThrow('spawn ENOENT');
  });

  it('kills the process group and rejects with a timeout message when timeoutMs elapses', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const childEmitter = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      // Never emit 'close' — simulates a hung process.
      return {
        pid: 4242,
        stdout,
        stderr,
        kill: () => {},
        on: childEmitter.on.bind(childEmitter),
        once: childEmitter.once.bind(childEmitter),
      } as unknown as ReturnType<typeof spawn>;
    });

    await expect(runAgentDiagnose('p', 'm', 50)).rejects.toThrow('agent timed out after 0.05s');
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
  });

  it('falls back to a direct kill when the process-group kill throws', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    let killCount = 0;
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const childEmitter = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      return {
        pid: 4242,
        stdout,
        stderr,
        kill: () => { killCount++; },
        on: childEmitter.on.bind(childEmitter),
        once: childEmitter.once.bind(childEmitter),
      } as unknown as ReturnType<typeof spawn>;
    });

    await expect(runAgentDiagnose('p', 'm', 50)).rejects.toThrow('agent timed out after 0.05s');
    expect(killCount).toBe(1);
  });
});

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

  describe('parseDiagnoseRequestBody', () => {
    it('rejects non-object bodies', () => {
      expect(parseDiagnoseRequestBody(null)).toEqual({
        ok: false,
        error: 'Invalid JSON body: expected an object',
      });
      expect(parseDiagnoseRequestBody('a string')).toEqual({
        ok: false,
        error: 'Invalid JSON body: expected an object',
      });
      expect(parseDiagnoseRequestBody(['not', 'an', 'object'])).toEqual({
        ok: false,
        error: 'Invalid JSON body: expected an object',
      });
    });

    it('rejects a missing or blank prompt', () => {
      expect(parseDiagnoseRequestBody({ namespace: 'prod' })).toEqual({
        ok: false,
        error: '"prompt" is required and must be a non-empty string',
      });
      expect(parseDiagnoseRequestBody({ prompt: '   ' })).toEqual({
        ok: false,
        error: '"prompt" is required and must be a non-empty string',
      });
      expect(parseDiagnoseRequestBody({ prompt: 42 })).toEqual({
        ok: false,
        error: '"prompt" is required and must be a non-empty string',
      });
    });

    it('trims prompt and normalizes optional fields', () => {
      expect(parseDiagnoseRequestBody({ prompt: '  why is pod x crashing?  ' })).toEqual({
        ok: true,
        prompt: 'why is pod x crashing?',
        namespace: undefined,
        model: undefined,
      });
    });

    it('passes through namespace and model when they are strings', () => {
      expect(
        parseDiagnoseRequestBody({
          prompt: 'Check pod health',
          namespace: 'staging',
          model: 'anthropic/claude-opus-4-8',
        }),
      ).toEqual({
        ok: true,
        prompt: 'Check pod health',
        namespace: 'staging',
        model: 'anthropic/claude-opus-4-8',
      });
    });

    it('ignores non-string namespace and model', () => {
      expect(
        parseDiagnoseRequestBody({ prompt: 'Check pod health', namespace: 42, model: [] }),
      ).toEqual({
        ok: true,
        prompt: 'Check pod health',
        namespace: undefined,
        model: undefined,
      });
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

describe('parseServeArgv', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty result for no args', () => {
    expect(parseServeArgv([])).toEqual({ port: undefined, host: undefined, model: undefined });
  });

  it('parses --port, --host, --model in space-separated form', () => {
    expect(parseServeArgv(['--port', '8080', '--host', '0.0.0.0', '--model', 'anthropic/claude-opus-4-8'])).toEqual({
      port: 8080,
      host: '0.0.0.0',
      model: 'anthropic/claude-opus-4-8',
    });
  });

  it('parses --port=, --host=, --model= in equals form', () => {
    expect(parseServeArgv(['--port=8080', '--host=0.0.0.0', '--model=anthropic/claude-opus-4-8'])).toEqual({
      port: 8080,
      host: '0.0.0.0',
      model: 'anthropic/claude-opus-4-8',
    });
  });

  it('exits 1 with a single error when --port is missing a value', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    parseServeArgv(['--port']);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith('Error: --port requires a value\n');
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 with a labeled error when --port is out of range', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    parseServeArgv(['--port', '99999']);
    expect(stderrSpy).toHaveBeenCalledWith('Error: --port must be an integer between 1 and 65535, got "99999"\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints usage and exits 0 for --help/-h', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    parseServeArgv(['--help']);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: heimdall serve'));
    expect(exitSpy).toHaveBeenCalledWith(0);

    parseServeArgv(['-h']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 1 with an error for an unknown option', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    parseServeArgv(['--bogus']);
    expect(stderrSpy).toHaveBeenCalledWith('Error: unknown option: --bogus\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('leaves --host and --model undefined when their value is omitted (historical behavior)', () => {
    expect(parseServeArgv(['--host'])).toEqual({ port: undefined, host: undefined, model: undefined });
    expect(parseServeArgv(['--model'])).toEqual({ port: undefined, host: undefined, model: undefined });
  });
});
