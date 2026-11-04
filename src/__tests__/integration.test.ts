/**
 * End-to-end CLI, Pi Durable runtime, HTTP serve-mode, session lifecycle,
 * and read-only safety integration tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  AssistantEntry,
  MemoryStorage,
  UserEntry,
  type ToolExecutionApi,
} from '@earendil-works/pi-durable';
import type { JsonValue } from '@earendil-works/chord';
import heimdallAgent from '../agents/heimdall.ts';
import triageWorkflow from '../workflows/triage.ts';
import { createSessionClient, extractAssistantText } from '../lib/pi-durable.ts';
import { makeKubectl } from '../tools/kubectl.ts';
import { createServeApp } from '../serve-mode.ts';
import { createAgentCoreApp } from '../agentcore-handler.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = resolve(ROOT, 'bin/heimdall');
const NODE_BIN_DIR = dirname(process.execPath);

function heimdallWithEnv(extraEnv: Record<string, string>, ...args: string[]) {
  const result = spawnSync(BIN, args, {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 15_000,
    env: {
      ...process.env,
      PATH: `${NODE_BIN_DIR}:${process.env['PATH'] ?? ''}`,
      ...extraEnv,
    },
  });
  if (result.error) throw result.error;
  return result;
}

function heimdall(...args: string[]) {
  return heimdallWithEnv({}, ...args);
}

describe('heimdall binary smoke tests', () => {
  it('--help exits 0 and shows usage', () => {
    const { status, stdout } = heimdall('--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('-p, --prompt');
    expect(stdout).toContain('--watch');
    expect(stdout).toContain('triage');
    expect(stdout).toContain('pi-durable');
  });

  it('-h is an alias for --help', () => {
    const { status, stdout } = heimdall('-h');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage:');
  });

  it('exits 1 when called with no arguments', () => {
    const { status, stderr } = heimdall();
    expect(status).toBe(1);
    expect(stderr).toMatch(/Error:/);
  });

  it('exits 1 for an unrecognised flag', () => {
    const { status, stderr } = heimdall('--no-such-flag');
    expect(status).toBe(1);
    expect(stderr).toContain('unknown option');
  });

  it('exits 1 for an unexpected positional argument', () => {
    const { status, stderr } = heimdall('unknownsubcmd');
    expect(status).toBe(1);
    expect(stderr).toContain('unexpected argument');
  });

  it('exits 1 when --json and --watch are combined', () => {
    const { status, stderr } = heimdall('--json', '--watch');
    expect(status).toBe(1);
    expect(stderr).toContain('not compatible');
  });

  it('exits 1 when -p is missing its argument', () => {
    const { status, stderr } = heimdall('-p');
    expect(status).toBe(1);
    expect(stderr).toMatch(/Error:/);
  });

  it('exits 1 for --format with an unknown value', () => {
    const { status, stderr } = heimdall('--format', 'csv');
    expect(status).toBe(1);
    expect(stderr).toContain('unknown format');
  });
});

// ---------------------------------------------------------------------------
// --model flag validation
// ---------------------------------------------------------------------------

describe('heimdall --model flag validation', () => {
  it('exits 1 when --model value has no provider/ prefix', () => {
    const { status, stderr } = heimdall('--model', 'claude-opus-4-8', '-p', 'test');
    expect(status).toBe(1);
    expect(stderr).toContain('provider/model');
  });

  it('exits 1 for --model= with no provider/ prefix', () => {
    const { status, stderr } = heimdall('--model=claude-opus-4-8', '-p', 'test');
    expect(status).toBe(1);
    expect(stderr).toContain('provider/model');
  });

  it('exits 1 for --model= with an empty value', () => {
    const { status, stderr } = heimdall('--model=', '-p', 'test');
    expect(status).toBe(1);
    expect(stderr).toMatch(/Error:/);
  });

  it('exits 1 when --model has no argument', () => {
    const { status, stderr } = heimdall('-p', 'test', '--model');
    expect(status).toBe(1);
    expect(stderr).toMatch(/Error:/);
  });
});

// ---------------------------------------------------------------------------
// --backend flag validation
// ---------------------------------------------------------------------------

describe('heimdall --backend flag validation', () => {
  it('exits 1 for an unknown backend', () => {
    const { status, stderr } = heimdall('--backend', 'llama', '-p', 'test');
    expect(status).toBe(1);
    expect(stderr).toContain('unknown backend');
  });

  it('exits 1 when --backend has no argument', () => {
    const { status, stderr } = heimdall('-p', 'test', '--backend');
    expect(status).toBe(1);
    expect(stderr).toMatch(/Error:/);
  });

  it('exits 1 for --backend claude-cli combined with --watch', () => {
    const { status, stderr } = heimdall('--backend', 'claude-cli', '--watch');
    expect(status).toBe(1);
    expect(stderr).toContain('not compatible');
  });

  it('exits 1 for --backend codex-cli combined with --watch', () => {
    const { status, stderr } = heimdall('--backend', 'codex-cli', '--watch');
    expect(status).toBe(1);
    expect(stderr).toContain('not compatible');
  });

  it('exits 1 for --backend claude-cli combined with triage', () => {
    const { status, stderr } = heimdall('--backend', 'claude-cli', 'triage');
    expect(status).toBe(1);
    expect(stderr).toContain('not compatible');
  });

  it('exits 1 for --backend codex-cli combined with triage', () => {
    const { status, stderr } = heimdall('--backend', 'codex-cli', 'triage');
    expect(status).toBe(1);
    expect(stderr).toContain('not compatible');
  });
});

// ---------------------------------------------------------------------------
// --json incompatibility checks
// ---------------------------------------------------------------------------

describe('heimdall --json incompatibility checks', () => {
  it('exits 1 when --json and triage are combined', () => {
    const { status, stderr } = heimdall('--json', 'triage');
    expect(status).toBe(1);
    expect(stderr).toContain('not compatible');
  });

  it('exits 1 when --json and schedule are combined', () => {
    const { status, stderr } = heimdall('--json', 'schedule');
    expect(status).toBe(1);
    expect(stderr).toContain('not compatible');
  });

  it('exits 1 when --json and self-improve are combined', () => {
    const { status, stderr } = heimdall('--json', 'self-improve');
    expect(status).toBe(1);
    expect(stderr).toContain('not compatible');
  });

  it('exits 1 when --json and self-loop are combined', () => {
    const { status, stderr } = heimdall('--json', 'self-loop');
    expect(status).toBe(1);
    expect(stderr).toContain('not compatible');
  });
});

// ---------------------------------------------------------------------------
// --format flag edge cases
// ---------------------------------------------------------------------------

describe('heimdall --format flag edge cases', () => {
  it('exits 1 when --format has no argument', () => {
    const { status, stderr } = heimdall('-p', 'test', '--format');
    expect(status).toBe(1);
    expect(stderr).toMatch(/Error:/);
  });
});

// ---------------------------------------------------------------------------
// Subcommand --help integration tests
// ---------------------------------------------------------------------------

describe('heimdall subcommand --help integration tests', () => {
  it('triage --help exits 0 and prints triage options', () => {
    const { status, stdout } = heimdall('triage', '--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: heimdall triage');
    expect(stdout).toContain('--all-namespaces');
    expect(stdout).toContain('--contexts');
  });

  it('serve --help exits 0 and prints serve options', () => {
    const { status, stdout } = heimdall('serve', '--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: heimdall serve');
    expect(stdout).toContain('--port');
    expect(stdout).toContain('--host');
  });

  it('schedule --help exits 0 and prints schedule options', () => {
    const { status, stdout } = heimdall('schedule', '--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: heimdall schedule');
    expect(stdout).toContain('--once');
  });

  it('eval --help exits 0 and prints eval options', () => {
    const { status, stdout } = heimdall('eval', '--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: heimdall eval');
    expect(stdout).toContain('--scenario');
  });

  it('self-improve --help exits 0 and prints self-improve options', () => {
    const { status, stdout } = heimdall('self-improve', '--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: heimdall self-improve');
    expect(stdout).toContain('--reflect');
    expect(stdout).toContain('--from-log');
  });

  it('self-loop --help exits 0 and prints self-loop options', () => {
    const { status, stdout } = heimdall('self-loop', '--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: heimdall self-loop');
    expect(stdout).toContain('--max-iterations');
    expect(stdout).toContain('--dry-run');
  });

  it('session --help exits 0 and prints session subcommands', () => {
    const { status, stdout } = heimdall('session', '--help');
    expect(status).toBe(0);
    expect(stdout).toContain('heimdall session start');
    expect(stdout).toContain('heimdall session prompt');
    expect(stdout).toContain('heimdall session list');
    expect(stdout).toContain('heimdall session info');
    expect(stdout).toContain('heimdall session end');
  });
});

// ---------------------------------------------------------------------------
// End-to-end session CLI lifecycle integration test
// ---------------------------------------------------------------------------

describe('heimdall session CLI lifecycle integration', () => {
  let sessionDir: string;

  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), 'heimdall-int-sessions-'));
  });

  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  it('manages the full session lifecycle: list (empty) -> start -> list -> info -> end -> list (empty)', () => {
    const env = { HEIMDALL_SESSION_DIR: sessionDir };

    // 1. Initially empty
    const emptyList = heimdallWithEnv(env, 'session', 'list');
    expect(emptyList.status).toBe(0);
    expect(emptyList.stdout).toContain('No active sessions.');

    // 2. Start a named session
    const started = heimdallWithEnv(
      env,
      'session',
      'start',
      '--name',
      'prod-oom-debug',
      '--server',
      'http://localhost:3583',
    );
    expect(started.status).toBe(0);
    expect(started.stdout).toContain('Session created:');
    const match = /Session ID:\s*([0-9a-f-]{36})/i.exec(started.stdout);
    expect(match).not.toBeNull();
    const sessionId = match![1];

    // 3. List sessions and verify the new session is present
    const populatedList = heimdallWithEnv(env, 'session', 'list');
    expect(populatedList.status).toBe(0);
    expect(populatedList.stdout).toContain('1 session(s):');
    expect(populatedList.stdout).toContain(sessionId);
    expect(populatedList.stdout).toContain('(prod-oom-debug)');

    // 4. Inspect session info
    const info = heimdallWithEnv(env, 'session', 'info', sessionId);
    expect(info.status).toBe(0);
    expect(info.stdout).toContain(sessionId);
    expect(info.stdout).toContain('http://localhost:3583');

    // 5. End the session
    const ended = heimdallWithEnv(env, 'session', 'end', sessionId);
    expect(ended.status).toBe(0);
    expect(ended.stdout).toContain(`Session ${sessionId} ended.`);

    // 6. Verify session list is empty again
    const finalList = heimdallWithEnv(env, 'session', 'list');
    expect(finalList.status).toBe(0);
    expect(finalList.stdout).toContain('No active sessions.');
  });
});

// ---------------------------------------------------------------------------
// Pi Durable Harness, SQLite persistence, and read-only tool integration
// ---------------------------------------------------------------------------

describe('Pi Durable Harness & Heimdall tool integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'heimdall-pi-int-'));
  });

  afterEach(async () => {
    delete process.env['HEIMDALL_KUBECTL_MOCK'];
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('registers all enabled Heimdall tools with replay="safe" on a Pi Durable Harness', async () => {
    const { harness, conversation, runtime } = await heimdallAgent.openHarness({
      storage: new MemoryStorage(),
    });

    try {
      expect(runtime.tools.length).toBeGreaterThan(0);
      for (const tool of runtime.tools) {
        expect(tool.replay).toBe('safe');
        expect(tool.parameters.type).toBe('object');
      }

      const agentState = await conversation.agent(BACKGROUND_CONTEXT);
      const offeredNames = agentState.tools.map((t) => t.name);
      expect(offeredNames).toContain('kubectl');
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });

  it('executes allowed read-only kubectl commands and blocks destructive commands via Pi Durable tool.execute()', async () => {
    const mockPath = join(tmpDir, 'kubectl-mock.json');
    await writeFile(
      mockPath,
      JSON.stringify({
        'get pods -n prod': 'NAME    READY   STATUS             RESTARTS   AGE\napi-0   0/1     CrashLoopBackOff   5          10m',
      }),
      'utf8',
    );
    process.env['HEIMDALL_KUBECTL_MOCK'] = mockPath;

    const kubectlTool = makeKubectl(null, false, [], null);

    // 1. Read-only command succeeds through Pi Durable execute()
    const allowedResult = await kubectlTool.execute(
      { args: 'get pods -n prod' },
      {} as unknown as ToolExecutionApi<JsonValue>,
      BACKGROUND_CONTEXT,
    );
    expect(allowedResult.output).toEqual([
      {
        type: 'text',
        text: 'NAME    READY   STATUS             RESTARTS   AGE\napi-0   0/1     CrashLoopBackOff   5          10m',
      },
    ]);

    // 2. Destructive command is blocked by safety harness even when invoked via Pi Durable execute()
    const blockedResult = await kubectlTool.execute(
      { args: 'delete pod api-0 -n prod' },
      {} as unknown as ToolExecutionApi<JsonValue>,
      BACKGROUND_CONTEXT,
    );
    const blockedText = (blockedResult.output?.[0] as { type: 'text'; text: string }).text;
    expect(blockedText).toMatch(/^BLOCKED:/);
  });

  it('persists and recovers conversation transcripts across Harness restarts using SQLite storage', async () => {
    const sqlitePath = join(tmpDir, 'heimdall-durable.sqlite');

    // First process: open SQLite harness and commit user + assistant entries
    const first = await heimdallAgent.openHarness({ sqlitePath });
    try {
      await first.conversation.commit(async (tx) => {
        await tx.appendEntry(first.conversation.id, {
          kind: UserEntry.kind,
          model: [{ role: 'user', content: 'Investigate CrashLoopBackOff in prod', timestamp: Date.now() }],
        });
        await tx.appendEntry(first.conversation.id, {
          kind: AssistantEntry.kind,
          model: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'Thinking Summary:\n- Checked pod logs\n\nAnswer:\nPod api-0 exited with code 137 (OOMKilled).' }],
              api: 'anthropic-messages',
              provider: 'anthropic',
              model: 'claude-sonnet-4-6',
              usage: {
                input: 15,
                output: 25,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 40,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: 'stop',
              timestamp: Date.now(),
            },
          ],
        });
      }, BACKGROUND_CONTEXT);
    } finally {
      await first.harness.close(BACKGROUND_CONTEXT);
    }

    // Second process: reopen SQLite harness on the same file and verify durable recovery
    const second = await heimdallAgent.openHarness({ sqlitePath });
    try {
      const recoveredText = await extractAssistantText(second.conversation, BACKGROUND_CONTEXT);
      expect(recoveredText).toContain('Pod api-0 exited with code 137 (OOMKilled).');
    } finally {
      await second.harness.close(BACKGROUND_CONTEXT);
    }
  });

  it('runs the Pi Durable triage workflow end-to-end with namespace and context options', async () => {
    const capturedPrompts: string[] = [];
    const result = await triageWorkflow.execute(
      { namespace: 'staging', allNamespaces: false, contexts: ['eks-staging'] },
      {
        harness: {
          session: async () => ({
            prompt: async (msg: string) => {
              capturedPrompts.push(msg);
              return { text: '### Critical\nNone\n### Warning\n- Deployment web replica mismatch' };
            },
          }),
        },
      },
    );

    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).toContain('staging');
    expect(capturedPrompts[0]).toContain('eks-staging');
    expect(result.report).toContain('Deployment web replica mismatch');
  });
});

// ---------------------------------------------------------------------------
// HTTP Serve Mode, Session Client, & AgentCore Handler Integration Tests
// ---------------------------------------------------------------------------

describe('HTTP serve-mode, createSessionClient, and AgentCore integration', () => {
  const mockFinding = {
    summary: '- Pod api-0 is OOMKilled',
    answer: 'Increase memory limits on deployment/api in namespace prod.',
    severity: 'critical',
    suggestedCommands: ['kubectl describe pod api-0 -n prod'],
    model: 'anthropic/claude-sonnet-4-6',
    validityScore: 0.95,
  };

  it('serves /api/health, /api/openapi.json, /metrics, and authenticated /api/diagnose', async () => {
    const app = createServeApp(
      async (prompt, model) => JSON.stringify({ ...mockFinding, promptEcho: prompt, model }),
      'anthropic/claude-sonnet-4-6',
      'secret-api-token',
      'heimdall-int-test',
    );

    // 1. /api/health is public even when apiKey is set
    const healthRes = await app.request('/api/health');
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ status: 'ok', service: 'heimdall' });

    // 2. /metrics is public and returns Prometheus format with custom service name
    const metricsRes = await app.request('/metrics');
    expect(metricsRes.status).toBe(200);
    expect(await metricsRes.text()).toContain('heimdall-int-test');

    // 3. /api/diagnose rejects unauthenticated requests with 401
    const unauthRes = await app.request('/api/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Check pods' }),
    });
    expect(unauthRes.status).toBe(401);

    // 4. /api/diagnose succeeds with Bearer token
    const diagRes = await app.request('/api/diagnose', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret-api-token',
      },
      body: JSON.stringify({ prompt: 'Check pods', namespace: 'prod' }),
    });
    expect(diagRes.status).toBe(200);
    const diagBody = (await diagRes.json()) as typeof mockFinding;
    expect(diagBody.severity).toBe('critical');
    expect(diagBody.answer).toContain('Increase memory limits');
  });

  it('round-trips createSessionClient against serve-mode /api/diagnose', async () => {
    const app = createServeApp(async () => JSON.stringify(mockFinding));

    const client = createSessionClient({
      baseUrl: 'http://heimdall.local',
      fetchFn: (input, init) => Promise.resolve(app.request(String(input), init)),
    });

    const response = await client.agents.prompt('heimdall', 'session-uuid-1', {
      message: 'Why is api-0 crashing?',
    });
    expect(response).toEqual({
      result: {
        text: 'Increase memory limits on deployment/api in namespace prod.',
      },
    });
  });

  it('handles AgentCore /ping and /invocations protocol end-to-end', async () => {
    const app = createAgentCoreApp(
      async () => JSON.stringify(mockFinding),
      'anthropic/claude-sonnet-4-6',
    );

    const pingRes = await app.request('/ping');
    expect(pingRes.status).toBe(200);
    expect(await pingRes.text()).toBe('OK');

    const invRes = await app.request('/invocations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputText: 'Diagnose prod namespace',
        sessionId: 'ac-sess-1',
        sessionAttributes: { env: 'prod' },
      }),
    });
    expect(invRes.status).toBe(200);
    const invBody = (await invRes.json()) as {
      outputText: string;
      sessionId: string;
      sessionAttributes: Record<string, string>;
    };
    expect(invBody.outputText).toBe(mockFinding.answer);
    expect(invBody.sessionId).toBe('ac-sess-1');
    expect(invBody.sessionAttributes.env).toBe('prod');
    expect(invBody.sessionAttributes.heimdall_severity).toBe('critical');
    expect(invBody.sessionAttributes.heimdall_validity_score).toBe('0.95');
  });
});
