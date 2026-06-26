/**
 * Unit tests for the AWS Lambda handler.
 *
 * Tests createLambdaHandler in isolation via dependency injection — no real
 * agent subprocess is spawned. Mock API Gateway v2 events are used to exercise
 * all routes exposed by the wrapped Hono app.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config.ts', () => ({
  loadConfig: () => ({
    tools: { kubectl: true },
    server: { port: 3000, host: '127.0.0.1' },
  }),
}));

import { createLambdaHandler } from '../../lambda-handler.ts';
import type { LambdaEvent, APIGatewayProxyResult, LambdaContext } from 'hono/aws-lambda';

// Cast the handler to an async function since Hono always returns a Promise.
type InvokeFn = (event: LambdaEvent, ctx: LambdaContext) => Promise<APIGatewayProxyResult>;

const MOCK_CONTEXT: LambdaContext = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: 'heimdall',
  functionVersion: '$LATEST',
  invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:heimdall',
  memoryLimitInMB: '1024',
  awsRequestId: 'test-request-id',
  logGroupName: '/aws/lambda/heimdall',
  logStreamName: '2026/01/01/[$LATEST]test',
  getRemainingTimeInMillis: () => 60_000,
};

/** Build a minimal API Gateway v2 / Lambda Function URL event. */
function makeEvent(
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): LambdaEvent {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: { 'content-type': 'application/json', ...headers },
    requestContext: {
      accountId: '123456789012',
      apiId: 'test-api-id',
      authentication: null,
      authorizer: {},
      domainName: 'test.lambda-url.us-east-1.on.aws',
      domainPrefix: 'test',
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '1.2.3.4',
        userAgent: 'test-agent',
      },
      requestId: 'test-req-id',
      routeKey: '$default',
      stage: '$default',
      time: '01/Jan/2026:00:00:00 +0000',
      timeEpoch: 1_735_689_600_000,
    },
    body: body ?? null,
    isBase64Encoded: false,
  };
}

const neverCalled = async (_prompt: string, _model: string): Promise<string> => {
  throw new Error('agent should not be called');
};

describe('createLambdaHandler — routing', () => {
  let invoke: InvokeFn;

  beforeEach(() => {
    invoke = createLambdaHandler(neverCalled) as unknown as InvokeFn;
  });

  it('GET /api/health returns 200 with JSON status', async () => {
    const result = await invoke(makeEvent('GET', '/api/health'), MOCK_CONTEXT);
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body).toEqual({ status: 'ok', service: 'heimdall' });
  });

  it('GET /api/openapi.json returns 200 with a 3.1 spec', async () => {
    const result = await invoke(makeEvent('GET', '/api/openapi.json'), MOCK_CONTEXT);
    expect(result.statusCode).toBe(200);
    const spec = JSON.parse(result.body) as Record<string, unknown>;
    expect(spec['openapi']).toBe('3.1.0');
    const paths = spec['paths'] as Record<string, unknown>;
    expect(paths['/api/diagnose']).toBeDefined();
    expect(paths['/api/health']).toBeDefined();
  });

  it('POST /api/diagnose with missing prompt returns 400', async () => {
    const result = await invoke(
      makeEvent('POST', '/api/diagnose', JSON.stringify({ namespace: 'prod' })),
      MOCK_CONTEXT,
    );
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(typeof body['error']).toBe('string');
  });

  it('POST /api/diagnose with empty prompt returns 400', async () => {
    const result = await invoke(
      makeEvent('POST', '/api/diagnose', JSON.stringify({ prompt: '   ' })),
      MOCK_CONTEXT,
    );
    expect(result.statusCode).toBe(400);
  });

  it('POST /api/diagnose with invalid JSON body returns 400', async () => {
    const result = await invoke(
      makeEvent('POST', '/api/diagnose', 'not-json'),
      MOCK_CONTEXT,
    );
    expect(result.statusCode).toBe(400);
  });

  it('POST /api/diagnose with invalid model format returns 400', async () => {
    const result = await invoke(
      makeEvent(
        'POST',
        '/api/diagnose',
        JSON.stringify({ prompt: 'why are pods failing?', model: 'no-slash' }),
      ),
      MOCK_CONTEXT,
    );
    expect(result.statusCode).toBe(400);
  });

  it('POST /api/diagnose calls agent and returns finding on success', async () => {
    const mockFinding = {
      summary: 'OOM kill on api-server',
      answer: 'The api pod was OOM-killed.',
      severity: 'critical',
      suggestedCommands: ['kubectl describe pod api -n prod'],
      model: 'anthropic/claude-sonnet-4-6',
    };
    const agentFn = vi.fn().mockResolvedValueOnce(JSON.stringify(mockFinding));
    const inv = createLambdaHandler(agentFn) as unknown as InvokeFn;

    const result = await inv(
      makeEvent('POST', '/api/diagnose', JSON.stringify({ prompt: 'why is api OOM?' })),
      MOCK_CONTEXT,
    );
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body['summary']).toBe('OOM kill on api-server');
    expect(body['severity']).toBe('critical');
  });

  it('POST /api/diagnose appends namespace scope to prompt', async () => {
    const mockFinding = {
      summary: 'all clear',
      answer: 'ok',
      severity: 'info',
      suggestedCommands: [],
      model: 'anthropic/claude-sonnet-4-6',
    };
    const agentFn = vi.fn().mockResolvedValueOnce(JSON.stringify(mockFinding));
    const inv = createLambdaHandler(agentFn) as unknown as InvokeFn;

    await inv(
      makeEvent(
        'POST',
        '/api/diagnose',
        JSON.stringify({ prompt: 'check health', namespace: 'staging' }),
      ),
      MOCK_CONTEXT,
    );
    expect(agentFn).toHaveBeenCalledWith(
      expect.stringContaining('namespace "staging"'),
      expect.any(String),
    );
  });

  it('POST /api/diagnose returns 500 when agent throws', async () => {
    const agentFn = vi.fn().mockRejectedValueOnce(new Error('agent timed out'));
    const inv = createLambdaHandler(agentFn) as unknown as InvokeFn;

    const result = await inv(
      makeEvent('POST', '/api/diagnose', JSON.stringify({ prompt: 'check health' })),
      MOCK_CONTEXT,
    );
    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body['error']).toContain('agent timed out');
  });
});

describe('createLambdaHandler — Bearer token auth', () => {
  const SECRET = 'lambda-test-secret-key-abc123';

  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env['HEIMDALL_API_KEY'];
    process.env['HEIMDALL_API_KEY'] = SECRET;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env['HEIMDALL_API_KEY'];
    } else {
      process.env['HEIMDALL_API_KEY'] = savedEnv;
    }
  });

  it('GET /api/health is always public (no auth)', async () => {
    const inv = createLambdaHandler(neverCalled) as unknown as InvokeFn;
    const result = await inv(makeEvent('GET', '/api/health'), MOCK_CONTEXT);
    expect(result.statusCode).toBe(200);
  });

  it('POST /api/diagnose returns 401 without Authorization header', async () => {
    const inv = createLambdaHandler(neverCalled) as unknown as InvokeFn;
    const result = await inv(
      makeEvent('POST', '/api/diagnose', JSON.stringify({ prompt: 'why failing?' })),
      MOCK_CONTEXT,
    );
    expect(result.statusCode).toBe(401);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body['error']).toBe('Unauthorized');
  });

  it('POST /api/diagnose returns 401 with wrong Bearer token', async () => {
    const inv = createLambdaHandler(neverCalled) as unknown as InvokeFn;
    const result = await inv(
      makeEvent(
        'POST',
        '/api/diagnose',
        JSON.stringify({ prompt: 'why failing?' }),
        { Authorization: 'Bearer wrong-key' },
      ),
      MOCK_CONTEXT,
    );
    expect(result.statusCode).toBe(401);
  });

  it('POST /api/diagnose succeeds with correct Bearer token', async () => {
    const mockFinding = {
      summary: 'healthy',
      answer: 'all ok',
      severity: 'info',
      suggestedCommands: [],
      model: 'anthropic/claude-sonnet-4-6',
    };
    const agentFn = vi.fn().mockResolvedValueOnce(JSON.stringify(mockFinding));
    const inv = createLambdaHandler(agentFn) as unknown as InvokeFn;

    const result = await inv(
      makeEvent(
        'POST',
        '/api/diagnose',
        JSON.stringify({ prompt: 'check cluster' }),
        { Authorization: `Bearer ${SECRET}` },
      ),
      MOCK_CONTEXT,
    );
    expect(result.statusCode).toBe(200);
    expect(agentFn).toHaveBeenCalledOnce();
  });

  it('GET /api/openapi.json returns 401 without auth', async () => {
    const inv = createLambdaHandler(neverCalled) as unknown as InvokeFn;
    const result = await inv(makeEvent('GET', '/api/openapi.json'), MOCK_CONTEXT);
    expect(result.statusCode).toBe(401);
  });
});

describe('createLambdaHandler — HEIMDALL_MODEL env var', () => {
  afterEach(() => {
    delete process.env['HEIMDALL_MODEL'];
  });

  it('accepts a valid HEIMDALL_MODEL env var', async () => {
    process.env['HEIMDALL_MODEL'] = 'anthropic/claude-haiku-4-5-20251001';
    const mockFinding = {
      summary: 'ok',
      answer: 'all fine',
      severity: 'info',
      suggestedCommands: [],
      model: 'anthropic/claude-haiku-4-5-20251001',
    };
    const agentFn = vi.fn().mockResolvedValueOnce(JSON.stringify(mockFinding));
    const inv = createLambdaHandler(agentFn) as unknown as InvokeFn;

    const result = await inv(
      makeEvent('POST', '/api/diagnose', JSON.stringify({ prompt: 'check health' })),
      MOCK_CONTEXT,
    );
    expect(result.statusCode).toBe(200);
    // The model passed to the agent function comes from the request or default; just
    // verify the call succeeded — actual model resolution is tested in model.test.ts.
    expect(agentFn).toHaveBeenCalledOnce();
  });

  it('falls back gracefully when HEIMDALL_MODEL is invalid format', async () => {
    process.env['HEIMDALL_MODEL'] = 'invalid-no-slash';
    const mockFinding = {
      summary: 'ok',
      answer: 'fine',
      severity: 'info',
      suggestedCommands: [],
      model: 'anthropic/claude-sonnet-4-6',
    };
    const agentFn = vi.fn().mockResolvedValueOnce(JSON.stringify(mockFinding));
    // createLambdaHandler should not throw even with an invalid env var
    expect(() => createLambdaHandler(agentFn)).not.toThrow();
  });
});
