import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isJsonOutput, parseDurationMs, getWaitTimeoutMs, runKubectl, tokenizeArgs } from '../kubectl.ts';

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
  });

  it('detects compact -ojson form (no space or equals)', () => {
    expect(isJsonOutput(['get', 'pods', '-ojson'])).toBe(true);
    expect(isJsonOutput(['-ojson', 'get', 'pods'])).toBe(true);
  });

  it('is false for non-json output', () => {
    expect(isJsonOutput(['get', 'pods', '-o', 'yaml'])).toBe(false);
    expect(isJsonOutput(['get', 'pods', '-o', 'wide'])).toBe(false);
    expect(isJsonOutput(['get', 'pods'])).toBe(false);
    expect(isJsonOutput(['get', 'pods', '-oyaml'])).toBe(false);
  });
});

describe('parseDurationMs', () => {
  it('parses seconds', () => {
    expect(parseDurationMs('30s')).toBe(30_000);
    expect(parseDurationMs('1s')).toBe(1_000);
  });

  it('parses minutes', () => {
    expect(parseDurationMs('2m')).toBe(120_000);
  });

  it('parses hours', () => {
    expect(parseDurationMs('1h')).toBe(3_600_000);
  });

  it('parses compound durations', () => {
    expect(parseDurationMs('1h30m')).toBe(5_400_000);
    expect(parseDurationMs('2m30s')).toBe(150_000);
    expect(parseDurationMs('1h30m45s')).toBe(5_445_000);
  });

  it('returns null for unrecognised input', () => {
    expect(parseDurationMs('')).toBeNull();
    expect(parseDurationMs('0s')).toBeNull();
    expect(parseDurationMs('abc')).toBeNull();
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
});

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

  // The allow path (get/describe/auth can-i not blocked) is asserted in
  // kubectl-safety.test.ts against validateCommand, without spawning kubectl —
  // executing an allowed command here would depend on a live cluster and the
  // runner's kubectl, which is exactly what makes such tests flaky/slow.
});

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
