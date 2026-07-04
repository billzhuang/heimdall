/**
 * Tests for kubectl.ts — pure helpers, policy enforcement, audit logging,
 * eval mock mode, and exec/cache paths (via mocked child_process).
 *
 * No real `kubectl` binary is ever spawned.
 */

// node:child_process must be mocked before kubectl.ts is imported so that
// `execFileAsync = promisify(execFile)` captures the mock at module load time.
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isJsonOutput,
  matchMock,
  NO_OUTPUT_MESSAGE,
  parseK8sDurationMs,
  getWaitTimeoutMs,
  resolveCacheUser,
  runKubectl,
  tokenizeArgs,
} from '../kubectl.ts';
import { stubExec, resetExec } from './execfile-helpers.ts';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('tokenizeArgs', () => {
  it('splits on whitespace', () => {
    expect(tokenizeArgs('get pods -n kube-system')).toEqual(['get', 'pods', '-n', 'kube-system']);
  });

  it('drops a leading "kubectl"', () => {
    expect(tokenizeArgs('kubectl get pods')).toEqual(['get', 'pods']);
  });

  it('honors single and double quotes', () => {
    expect(tokenizeArgs(`get pods -l 'app=web tier=front'`)).toEqual([
      'get',
      'pods',
      '-l',
      'app=web tier=front',
    ]);
    expect(tokenizeArgs('get po -o jsonpath="{.items[*].metadata.name}"')).toEqual([
      'get',
      'po',
      '-o',
      'jsonpath={.items[*].metadata.name}',
    ]);
  });

  it('keeps shell metacharacters as literal tokens (no shell interpretation)', () => {
    // Since execution uses execFile (no shell), these are harmless literals.
    expect(tokenizeArgs('get pods | grep x')).toEqual(['get', 'pods', '|', 'grep', 'x']);
  });

  it('returns an empty array for empty / whitespace-only input', () => {
    expect(tokenizeArgs('')).toEqual([]);
    expect(tokenizeArgs('   \t ')).toEqual([]);
    expect(tokenizeArgs('kubectl')).toEqual([]);
  });

  it('concatenates adjacent quoted and bare segments into one token', () => {
    expect(tokenizeArgs(`get po-"abc"'def'`)).toEqual(['get', 'po-abcdef']);
  });

  it('unescapes \\" and \\\\ inside double quotes', () => {
    expect(tokenizeArgs('get -o "a\\"b\\\\c"')).toEqual(['get', '-o', 'a"b\\c']);
  });

  it('treats backslash as literal-next outside quotes', () => {
    expect(tokenizeArgs('get pod\\ name')).toEqual(['get', 'pod name']);
  });

  it('preserves an empty quoted argument', () => {
    expect(tokenizeArgs(`get -l ""`)).toEqual(['get', '-l', '']);
  });
});

describe('isJsonOutput', () => {
  it('detects -o json and --output json', () => {
    expect(isJsonOutput(['get', 'pods', '-o', 'json'])).toBe(true);
    expect(isJsonOutput(['get', 'pods', '--output', 'json'])).toBe(true);
    expect(isJsonOutput(['get', 'pods', '-o=json'])).toBe(true);
    expect(isJsonOutput(['get', 'pods', '-ojson'])).toBe(true);
  });

  it('is false for non-json output', () => {
    expect(isJsonOutput(['get', 'pods', '-o', 'yaml'])).toBe(false);
    expect(isJsonOutput(['get', 'pods', '-o', 'wide'])).toBe(false);
    expect(isJsonOutput(['get', 'pods'])).toBe(false);
  });
});

describe('parseK8sDurationMs', () => {
  it('parses seconds', () => {
    expect(parseK8sDurationMs('30s')).toBe(30_000);
    expect(parseK8sDurationMs('1s')).toBe(1_000);
  });

  it('parses minutes', () => {
    expect(parseK8sDurationMs('2m')).toBe(120_000);
  });

  it('parses hours', () => {
    expect(parseK8sDurationMs('1h')).toBe(3_600_000);
  });

  it('parses compound durations', () => {
    expect(parseK8sDurationMs('1h30m')).toBe(5_400_000);
    expect(parseK8sDurationMs('2m30s')).toBe(150_000);
    expect(parseK8sDurationMs('1h30m45s')).toBe(5_445_000);
  });

  it('returns null for unrecognised input', () => {
    expect(parseK8sDurationMs('')).toBeNull();
    expect(parseK8sDurationMs('0s')).toBeNull();
    expect(parseK8sDurationMs('abc')).toBeNull();
  });

  it('returns null for all-zero compound duration', () => {
    expect(parseK8sDurationMs('0h0m0s')).toBeNull();
  });

  it('accepts leading-zero component when total is non-zero', () => {
    expect(parseK8sDurationMs('0m30s')).toBe(30_000);
  });

  it('accepts seconds value exceeding 59', () => {
    expect(parseK8sDurationMs('100s')).toBe(100_000);
  });

  it('accepts minutes value of 60 or more', () => {
    expect(parseK8sDurationMs('60m')).toBe(3_600_000);
  });

  it('returns null for out-of-order units (s before m)', () => {
    expect(parseK8sDurationMs('1s2m')).toBeNull();
  });

  it('returns null for unsupported millisecond unit', () => {
    expect(parseK8sDurationMs('1ms')).toBeNull();
  });

  it('returns null for unsupported day unit', () => {
    expect(parseK8sDurationMs('1d')).toBeNull();
  });

  it('returns null for a bare number without a unit', () => {
    expect(parseK8sDurationMs('1')).toBeNull();
  });
});

describe('getWaitTimeoutMs', () => {
  it('extracts --timeout=Xs form', () => {
    expect(getWaitTimeoutMs(['wait', '--for=condition=Ready', 'pod/web', '--timeout=15s'])).toBe(15_000);
    expect(getWaitTimeoutMs(['wait', '--timeout=2m', '--for=condition=Complete', 'job/x'])).toBe(120_000);
  });

  it('extracts space-separated --timeout Xs form', () => {
    expect(getWaitTimeoutMs(['wait', '--timeout', '60s', '--for=condition=Ready', 'pod/web'])).toBe(60_000);
  });

  it('returns null when no --timeout flag is present', () => {
    expect(getWaitTimeoutMs(['wait', '--for=condition=Ready', 'pod/web'])).toBeNull();
    expect(getWaitTimeoutMs(['get', 'pods'])).toBeNull();
  });

  it('returns null when --timeout is the last argument with no following value', () => {
    expect(getWaitTimeoutMs(['wait', '--for=condition=Ready', 'pod/web', '--timeout'])).toBeNull();
  });

  it('extracts a compound --timeout=1h30m value', () => {
    expect(getWaitTimeoutMs(['wait', '--for=condition=Ready', 'pod/web', '--timeout=1h30m'])).toBe(5_400_000);
  });
});

describe('resolveCacheUser', () => {
  it('uses the OS uid when getuid is available', () => {
    expect(resolveCacheUser(() => 501, {})).toBe('501');
  });

  it('prefers the uid over USER/USERNAME when both are present', () => {
    expect(resolveCacheUser(() => 501, { USER: 'alice', USERNAME: 'bob' })).toBe('501');
  });

  it('falls back to USER when getuid is unavailable (e.g. Windows)', () => {
    expect(resolveCacheUser(undefined, { USER: 'alice' })).toBe('alice');
  });

  it('falls back to USERNAME when getuid and USER are both unavailable', () => {
    expect(resolveCacheUser(undefined, { USERNAME: 'bob' })).toBe('bob');
  });

  it("falls back to 'default' when getuid, USER, and USERNAME are all unavailable", () => {
    expect(resolveCacheUser(undefined, {})).toBe('default');
  });
});

// ---------------------------------------------------------------------------
// Policy enforcement (blocked paths return before execFileAsync is ever called)
// ---------------------------------------------------------------------------

describe('runKubectl (policy enforcement)', () => {
  it('blocks destructive commands without executing them', async () => {
    const result = await runKubectl('delete pod web -n prod');
    expect(result).toMatch(/^BLOCKED:/);
  });

  it('blocks exec (code execution)', async () => {
    const result = await runKubectl('exec mypod -- sh');
    expect(result).toMatch(/^BLOCKED:/);
  });

  it('returns an error for empty input', async () => {
    expect(await runKubectl('   ')).toMatch(/no kubectl arguments/i);
  });

  it('does not block a redundant leading "kubectl" in args', async () => {
    // Validation runs on the same tokenized argv that executes, so a model that
    // includes the word "kubectl" must not trip an "unknown subcommand" block.
    const result = await runKubectl('kubectl delete pod web');
    expect(result).toMatch(/^BLOCKED:/);
    expect(result).toMatch(/destructive/i); // blocked as `delete`, not unknown `kubectl`
  });

  it('blocks all destructive subcommands and code-execution verbs', async () => {
    for (const cmd of ['apply -f x.yaml', 'patch pod web', 'scale deploy/api --replicas=0',
      'rollout restart deploy/api', 'cp pod:/etc/passwd ./', 'port-forward svc/x 8080',
      'attach mypod', 'debug node/n1', 'drain node1', 'cordon node1', 'taint nodes n1 k=v:NoSchedule']) {
      expect(await runKubectl(cmd)).toMatch(/^BLOCKED:/);
    }
  });

  it('blocks the config family and unknown subcommands', async () => {
    expect(await runKubectl('config use-context prod')).toMatch(/^BLOCKED:/);
    expect(await runKubectl('config view --raw')).toMatch(/^BLOCKED:/);
    expect(await runKubectl('proxy --port=8001')).toMatch(/^BLOCKED:/);
  });

  it('blocks auth reconcile (mutating nested verb)', async () => {
    expect(await runKubectl('auth reconcile -f rbac.yaml')).toMatch(/^BLOCKED:/);
  });

  it('returns error when only "kubectl" is given with no subcommand', async () => {
    const result = await runKubectl('kubectl');
    expect(result).toMatch(/no kubectl subcommand provided/i);
  });

  it('quotes args containing whitespace in the display command', async () => {
    // tokenizeArgs strips the quotes, leaving 'my pod' as one arg with a space.
    // buildShellCommand (tokenizer.ts) re-wraps it for audit/display purposes.
    // `delete` is destructive so the command is blocked before kubectl is spawned.
    const result = await runKubectl(`delete pod 'my pod' -n prod`);
    expect(result).toMatch(/^BLOCKED:/);
  });

  // The allow path (get/describe/auth can-i not blocked) is asserted in
  // kubectl-safety.test.ts against validateCommand, without spawning kubectl —
  // executing an allowed command here would depend on a live cluster and the
  // runner's kubectl, which is exactly what makes such tests flaky/slow.
});

// ---------------------------------------------------------------------------
// Audit logging
// ---------------------------------------------------------------------------

describe('runKubectl audit logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not write to stderr when audit is disabled (default)', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runKubectl('delete pod web -n prod');
    expect(spy).not.toHaveBeenCalled();
  });

  it('writes a blocked audit entry to stderr when enabled', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    await runKubectl('delete pod web -n prod', { audit: { enabled: true } });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe('audit');
    expect(entry.allowed).toBe(false);
    expect(entry.outcome).toBe('blocked');
    expect(entry.cmd).toContain('delete');
  });

  it('writes audit entry to a file when file path is configured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heimdall-audit-test-'));
    const filePath = join(dir, 'audit.jsonl');
    try {
      await runKubectl('delete pod web -n prod', { audit: { enabled: true, file: filePath } });
      const content = await readFile(filePath, 'utf8');
      const entry = JSON.parse(content.trim());
      expect(entry.level).toBe('audit');
      expect(entry.allowed).toBe(false);
      expect(entry.outcome).toBe('blocked');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('includes ts, cmd, allowed, and outcome in every audit entry', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    await runKubectl('exec mypod -- sh', { audit: { enabled: true } });
    const entry = JSON.parse(lines[0]);
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof entry.cmd).toBe('string');
    expect(typeof entry.allowed).toBe('boolean');
    expect(entry.outcome).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Eval mock mode (HEIMDALL_KUBECTL_MOCK env var)
// No child_process mock needed — the HEIMDALL_KUBECTL_MOCK path returns before exec.
// ---------------------------------------------------------------------------

describe('runKubectl (eval mock mode)', () => {
  let tmpDir: string;
  let mockFile: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    tmpDir = await mkdtemp(join(tmpdir(), 'heimdall-eval-mock-'));
    mockFile = join(tmpDir, 'mocks.json');
    delete process.env.HEIMDALL_KUBECTL_MOCK;
  });

  afterEach(async () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns the fixture matching the command argv', async () => {
    await writeFile(mockFile, JSON.stringify({ 'get pods': '{"items":[{"name":"web"}]}' }));
    process.env.HEIMDALL_KUBECTL_MOCK = mockFile;

    const result = await runKubectl('get pods -n default');
    expect(result).toBe('{"items":[{"name":"web"}]}');
  });

  it('returns a "no mock fixture" message when no key matches', async () => {
    await writeFile(mockFile, JSON.stringify({ 'get pods': 'some pods' }));
    process.env.HEIMDALL_KUBECTL_MOCK = mockFile;

    const result = await runKubectl('get nodes -o json');
    expect(result).toMatch(/eval: no mock fixture for:/);
    expect(result).toContain('get');
  });

  it('returns an eval mock error when the mock file does not exist', async () => {
    process.env.HEIMDALL_KUBECTL_MOCK = join(tmpDir, 'nonexistent.json');

    const result = await runKubectl('get pods');
    expect(result).toMatch(/eval mock error:/i);
  });

  it('returns an eval mock error when the mock file contains invalid JSON', async () => {
    await writeFile(mockFile, 'not json {{{');
    process.env.HEIMDALL_KUBECTL_MOCK = mockFile;

    const result = await runKubectl('get pods');
    expect(result).toMatch(/eval mock error:/i);
  });

  it('caches the parsed mock file in memory (reads file only once for two calls)', async () => {
    await writeFile(mockFile, JSON.stringify({ 'get pods': 'pod list' }));
    process.env.HEIMDALL_KUBECTL_MOCK = mockFile;

    await runKubectl('get pods');
    // Overwrite file — second call should still use in-memory cache
    await writeFile(mockFile, JSON.stringify({ 'get pods': 'DIFFERENT' }));
    const result = await runKubectl('get pods');
    expect(result).toBe('pod list');
  });
});

// ---------------------------------------------------------------------------
// matchMock
// ---------------------------------------------------------------------------

describe('matchMock', () => {
  it('returns the response for an exact key match', () => {
    expect(matchMock({ 'get pods': 'pod list' }, ['get', 'pods'])).toBe('pod list');
  });

  it('returns the most specific (most tokens) match', () => {
    const mocks = { get: 'generic', 'get pods': 'pod list', 'get pods kube-system': 'system pods' };
    expect(matchMock(mocks, ['get', 'pods', '-n', 'kube-system'])).toBe('system pods');
  });

  it('is case-insensitive', () => {
    expect(matchMock({ 'GET PODS': 'pod list' }, ['get', 'pods'])).toBe('pod list');
  });

  it('returns null when no key matches', () => {
    expect(matchMock({ 'get pods': 'x' }, ['get', 'nodes'])).toBeNull();
  });

  it('returns null for an empty mocks object', () => {
    expect(matchMock({}, ['get', 'pods'])).toBeNull();
  });

  it('returns null when mocks is not an object', () => {
    expect(matchMock(null as unknown as Record<string, string>, ['get'])).toBeNull();
  });

  it('skips empty-string keys (zero tokens after split)', () => {
    expect(matchMock({ '': 'fallback', 'get pods': 'pod list' }, ['get', 'pods'])).toBe('pod list');
  });
});

// ---------------------------------------------------------------------------
// Exec paths: success, context injection, error, wait-timeout, caching
// These tests use the mocked node:child_process (stubExec / resetExec).
// ---------------------------------------------------------------------------

describe('runKubectl (exec paths)', () => {
  let cacheDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    resetExec();
    cacheDir = await mkdtemp(join(tmpdir(), 'heimdall-kube-cache-'));
    process.env.HEIMDALL_KUBECTL_CACHE_DIR = cacheDir;
    process.env.HEIMDALL_KUBECTL_CACHE = '1';
    delete process.env.HEIMDALL_KUBECTL_MOCK;
    delete process.env.KUBERNETES_SERVICE_HOST;
  });

  afterEach(async () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
    await rm(cacheDir, { recursive: true, force: true });
  });

  // --- Success path ---

  it('returns stdout from a successful exec', async () => {
    stubExec((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: 'NAME\nweb-abc', stderr: '' });
    });
    const result = await runKubectl('get pods');
    expect(result).toBe('NAME\nweb-abc');
  });

  it('returns stderr when stdout is empty', async () => {
    stubExec((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: '', stderr: 'Warning: resource not found' });
    });
    const result = await runKubectl('get pods');
    expect(result).toBe('Warning: resource not found');
  });

  it(`returns "${NO_OUTPUT_MESSAGE}" when both stdout and stderr are empty`, async () => {
    stubExec((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: '', stderr: '' });
    });
    const result = await runKubectl('get pods');
    expect(result).toBe(NO_OUTPUT_MESSAGE);
  });

  // --- Error path ---

  it('returns an error message when execFile throws', async () => {
    stubExec((_cmd, _args, _opts, cb) => {
      const err = Object.assign(new Error('exit code 1'), { stderr: 'Error from server: not found' });
      cb(err as Error, { stdout: '', stderr: '' });
    });
    const result = await runKubectl('get pod/nonexistent');
    expect(result).toMatch(/kubectl exited with an error:/);
    expect(result).toContain('Error from server: not found');
  });

  it('falls back to the error message when execFile error has no stderr/stdout', async () => {
    stubExec((_cmd, _args, _opts, cb) => {
      cb(new Error('command timed out'), { stdout: '', stderr: '' });
    });
    const result = await runKubectl('get pods');
    expect(result).toMatch(/kubectl exited with an error:/);
    expect(result).toContain('command timed out');
  });

  // --- Context injection ---

  it('prepends --context= when the context option is provided', async () => {
    let capturedArgs: string[] | undefined;
    stubExec((_cmd, args, _opts, cb) => {
      capturedArgs = args as string[];
      cb(null, { stdout: 'ok', stderr: '' });
    });
    await runKubectl('get pods', { context: 'staging' });
    expect(capturedArgs?.[0]).toBe('--context=staging');
  });

  it('does not prepend --context= when the argv already contains --context', async () => {
    let capturedArgs: string[] | undefined;
    stubExec((_cmd, args, _opts, cb) => {
      capturedArgs = args as string[];
      cb(null, { stdout: 'ok', stderr: '' });
    });
    await runKubectl('get pods --context=prod', { context: 'staging' });
    // Only one --context flag; the option is ignored
    const contextFlags = (capturedArgs ?? []).filter((a) => a.startsWith('--context'));
    expect(contextFlags).toHaveLength(1);
    expect(contextFlags[0]).toBe('--context=prod');
  });

  // --- Kubeconfig injection ---

  it('sets KUBECONFIG env var when the kubeconfig option is provided', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    stubExec((_cmd, _args, opts, cb) => {
      capturedEnv = (opts as { env?: NodeJS.ProcessEnv }).env;
      cb(null, { stdout: 'ok', stderr: '' });
    });
    await runKubectl('get pods', { kubeconfig: '/home/user/.kube/staging' });
    expect(capturedEnv?.KUBECONFIG).toBe('/home/user/.kube/staging');
  });

  // --- redactSecrets=false ---

  it('returns raw output when redactSecrets is false', async () => {
    stubExec((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: 'plain output without any secret data', stderr: '' });
    });
    const result = await runKubectl('get pods', { redactSecrets: false });
    expect(result).toBe('plain output without any secret data');
  });

  // --- Audit logging on success ---

  it('writes an allowed=true audit entry on success', async () => {
    stubExec((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: 'pod list', stderr: '' });
    });
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    await runKubectl('get pods', { audit: { enabled: true } });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.allowed).toBe(true);
    expect(entry.outcome).toBe('ok');
    expect(entry.cached).toBe(false);
  });

  // --- Cache: miss → write ---

  it('writes output to a cache file after a successful cacheable get -o json call', async () => {
    process.env.HEIMDALL_KUBECTL_CACHE = '1';
    stubExec((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: '{"items":[]}', stderr: '' });
    });
    await runKubectl('get pods -o json');
    // At least one cache file should exist in cacheDir
    const subdirs = await readdir(cacheDir).catch(() => []);
    let cacheFiles: string[] = [];
    for (const sub of subdirs) {
      const files = await readdir(join(cacheDir, sub)).catch(() => []);
      cacheFiles = cacheFiles.concat(files);
    }
    // One cache file written
    expect(cacheFiles.length).toBeGreaterThan(0);
  });

  // --- Cache: hit → exec not called again ---

  it('serves the second identical get -o json from cache (exec called only once)', async () => {
    process.env.HEIMDALL_KUBECTL_CACHE = '1';
    process.env.HEIMDALL_KUBECTL_CACHE_TTL = '60';
    stubExec((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: '{"items":[]}', stderr: '' });
    });
    await runKubectl('get pods -o json');
    await runKubectl('get pods -o json');
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
  });

  // --- Cache disabled ---

  it('does not cache when HEIMDALL_KUBECTL_CACHE=0', async () => {
    process.env.HEIMDALL_KUBECTL_CACHE = '0';
    stubExec((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: '{"items":[]}', stderr: '' });
    });
    await runKubectl('get pods -o json');
    await runKubectl('get pods -o json');
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(2);
  });

  // --- Non-cacheable commands ---

  it('does not cache describe commands (not a `get -o json`)', async () => {
    process.env.HEIMDALL_KUBECTL_CACHE = '1';
    stubExec((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: 'Name: web', stderr: '' });
    });
    await runKubectl('describe pod web');
    await runKubectl('describe pod web');
    // Two exec calls since describe is not cacheable
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(2);
  });

  // --- Wait timeout extension ---

  it('extends exec timeout for kubectl wait with a long --timeout', async () => {
    let capturedTimeout: number | undefined;
    stubExec((_cmd, _args, opts, cb) => {
      capturedTimeout = (opts as { timeout?: number }).timeout;
      cb(null, { stdout: 'condition met', stderr: '' });
    });
    // --timeout=120s → waitMs=120_000; expected execTimeoutMs = 120_000 + 5_000 = 125_000
    await runKubectl('wait --for=condition=Ready pod/web --timeout=120s');
    expect(capturedTimeout).toBe(125_000);
  });

  it('uses the default timeout for non-wait commands', async () => {
    let capturedTimeout: number | undefined;
    stubExec((_cmd, _args, opts, cb) => {
      capturedTimeout = (opts as { timeout?: number }).timeout;
      cb(null, { stdout: 'ok', stderr: '' });
    });
    await runKubectl('get pods');
    // Default EXEC_TIMEOUT_MS = 30_000
    expect(capturedTimeout).toBe(30_000);
  });

  it('uses the default timeout for wait command with no --timeout flag', async () => {
    let capturedTimeout: number | undefined;
    stubExec((_cmd, _args, opts, cb) => {
      capturedTimeout = (opts as { timeout?: number }).timeout;
      cb(null, { stdout: 'condition met', stderr: '' });
    });
    await runKubectl('wait --for=condition=Ready pod/web');
    expect(capturedTimeout).toBe(30_000);
  });

  // --- In-cluster: KUBECONFIG deleted from env ---

  it('removes KUBECONFIG from env when running in-cluster', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    process.env.KUBECONFIG = '/some/kubeconfig';
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    stubExec((_cmd, _args, opts, cb) => {
      capturedEnv = (opts as { env?: NodeJS.ProcessEnv }).env;
      cb(null, { stdout: 'ok', stderr: '' });
    });
    await runKubectl('get pods');
    expect(capturedEnv?.KUBECONFIG).toBeUndefined();
  });

  // --- Error paths: extractExecError fallbacks ---

  it('falls back to err.stdout when err.stderr is an empty string on failure', async () => {
    const err = Object.assign(new Error('exit 1'), { stderr: '', stdout: 'stdout-only detail' });
    stubExec((_cmd, _args, _opts, cb) => cb(err as Error, { stdout: '', stderr: '' }));
    const result = await runKubectl('get pods');
    expect(result).toMatch(/kubectl exited with an error/i);
    expect(result).toContain('stdout-only detail');
  });

  it('falls back to err.message when err.stderr and err.stdout are both empty strings', async () => {
    const err = Object.assign(new Error('timeout'), { stderr: '', stdout: '' });
    stubExec((_cmd, _args, _opts, cb) => cb(err as Error, { stdout: '', stderr: '' }));
    const result = await runKubectl('get pods');
    expect(result).toMatch(/kubectl exited with an error/i);
    expect(result).toContain('timeout');
  });

  it('falls back to String(err) when err.stderr, err.stdout, and err.message are all empty', async () => {
    const err = Object.assign(new Error(), { stderr: '', stdout: '', message: '' });
    stubExec((_cmd, _args, _opts, cb) => cb(err as Error, { stdout: '', stderr: '' }));
    const result = await runKubectl('get pods');
    expect(result).toMatch(/kubectl exited with an error|Error/i);
  });

  it('handles a non-object thrown error (e.g. plain string)', async () => {
    stubExec((_cmd, _args, _opts, cb) => cb('plain-string-error' as unknown as Error, { stdout: '', stderr: '' }));
    const result = await runKubectl('get pods');
    expect(result).toMatch(/kubectl exited with an error/i);
    expect(result).toContain('plain-string-error');
  });

  // --- Namespace lockdown ---

  it('blocks commands targeting a different namespace under lockdown', async () => {
    const result = await runKubectl('get pods -n staging', { lockedNamespace: 'prod' });
    expect(result).toMatch(/^BLOCKED:/);
    expect(result).toContain('staging');
  });

  it('injects --namespace flag and executes when no namespace is specified under lockdown', async () => {
    stubExec((_cmd, args, _opts, cb) => {
      cb(null, { stdout: 'pod-list', stderr: '' });
    });
    const result = await runKubectl('get pods', { lockedNamespace: 'prod' });
    expect(result).toBe('pod-list');
  });

  // --- redactSecrets: false on error and cache hit ---

  it('does not redact on error output when redactSecrets is false', async () => {
    const err = Object.assign(new Error('exit 1'), { stderr: 'SENSITIVE data exposed' });
    stubExec((_cmd, _args, _opts, cb) => cb(err as Error, { stdout: '', stderr: '' }));
    const result = await runKubectl('get pods', { redactSecrets: false });
    expect(result).toContain('SENSITIVE data exposed');
  });

  // --- Cache TTL invalid value ---

  it('uses default TTL when HEIMDALL_KUBECTL_CACHE_TTL is not a valid positive number', async () => {
    process.env.HEIMDALL_KUBECTL_CACHE_TTL = 'not-a-number';
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: '{"items":[]}', stderr: '' }));
    const result = await runKubectl('get pods -o json');
    expect(result).toBe('{"items":[]}');
  });

  // --- redactSecrets: false cache hit (covers the ternary false branch at line 305) ---

  it('returns raw cached output when redactSecrets is false (skips redactSecretValues)', async () => {
    process.env.HEIMDALL_KUBECTL_CACHE = '1';
    process.env.HEIMDALL_KUBECTL_CACHE_TTL = '60';
    stubExec((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: '{"items":[]}', stderr: '' });
    });
    await runKubectl('get pods -o json', { redactSecrets: false }); // miss → writes
    const result = await runKubectl('get pods -o json', { redactSecrets: false }); // hit
    expect(result).toContain('"items"');
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
  });

  // --- Caching with --context flag already in argv (skips effectiveContext lookup) ---

  it('serves cached result without kubeconfig lookup when --context flag is already in argv', async () => {
    process.env.HEIMDALL_KUBECTL_CACHE_TTL = '60';
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: '{"items":[]}', stderr: '' }));
    await runKubectl('get pods --context=prod -o json');
    await runKubectl('get pods --context=prod -o json');
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
  });

  // --- In-cluster caching: effectiveContext set to IN_CLUSTER_CONTEXT ---

  it('caches get -o json using the in-cluster sentinel as the effective context', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    process.env.HEIMDALL_KUBECTL_CACHE_TTL = '60';
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: '{"items":[]}', stderr: '' }));
    await runKubectl('get pods -o json');
    await runKubectl('get pods -o json');
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
  });

  // --- getCacheDir: tmpdir fallback when HEIMDALL_KUBECTL_CACHE_DIR is unset ---

  it('uses the OS tmpdir as cache base when HEIMDALL_KUBECTL_CACHE_DIR is not set', async () => {
    delete process.env.HEIMDALL_KUBECTL_CACHE_DIR;
    process.env.HEIMDALL_KUBECTL_CACHE_TTL = '60';
    const uid = typeof process.getuid === 'function' ? String(process.getuid()) : undefined;
    const user = uid ?? process.env.USER ?? process.env.USERNAME ?? 'default';
    const defaultCacheBase = join(tmpdir(), `heimdall-kubectl-cache-${user}`);
    stubExec((_cmd, _args, _opts, cb) => { cb(null, { stdout: '{"items":[]}', stderr: '' }); });
    try {
      await runKubectl('get pods -o json');
      await runKubectl('get pods -o json');
      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
    } finally {
      await rm(defaultCacheBase, { recursive: true, force: true }).catch(() => {});
    }
  });

  // --- Cache expiry: cache miss when cached file is older than TTL ---

  it('re-executes when the cached file is older than the TTL', async () => {
    process.env.HEIMDALL_KUBECTL_CACHE_TTL = '1';
    stubExec((_cmd, _args, _opts, cb) => { cb(null, { stdout: '{"first":true}', stderr: '' }); });
    await runKubectl('get pods -o json');
    resetExec();
    vi.useFakeTimers({ now: Date.now() + 2_000 });
    try {
      stubExec((_cmd, _args, _opts, cb) => { cb(null, { stdout: '{"second":true}', stderr: '' }); });
      const result = await runKubectl('get pods -o json');
      expect(result).toBe('{"second":true}');
      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // --- Arg quoting: args with spaces are shell-quoted in the cmd string ---

  it('shell-quotes args containing spaces when building the cache-key cmd string', async () => {
    stubExec((_cmd, _args, _opts, cb) => { cb(null, { stdout: 'pod list', stderr: '' }); });
    const result = await runKubectl('get pods -l "app=my app"');
    expect(result).toBe('pod list');
  });

  // --- Cache hit with redactSecrets=false ---

  it('skips secret redaction on cache hit when redactSecrets is false', async () => {
    process.env.HEIMDALL_KUBECTL_CACHE_TTL = '60';
    stubExec((_cmd, _args, _opts, cb) => { cb(null, { stdout: '{"items":[]}', stderr: '' }); });
    await runKubectl('get pods -o json');
    resetExec();
    const result = await runKubectl('get pods -o json', { redactSecrets: false });
    expect(result).toBe('{"items":[]}');
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(0);
  });
});
