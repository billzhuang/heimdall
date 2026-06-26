/**
 * Tests for trivy.ts — policy decisions, input validation, and mocked exec paths.
 *
 * Real `trivy` is NOT invoked. Exec paths are exercised via a vi.mock on
 * node:child_process so we test the full function surface without a scanner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { runTrivy } from '../trivy.ts';
import { stubExec, resetExec } from './execfile-helpers.ts';
import { BLOCKED_RE } from './test-helpers.ts';

beforeEach(() => {
  resetExec();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Input validation (returns before exec)
// ---------------------------------------------------------------------------

describe('runTrivy — input validation (no exec)', () => {
  it('returns error when scanType is empty', async () => {
    const result = await runTrivy('', 'nginx:latest', []);
    expect(result).toMatch(/scan type and target are required/i);
  });

  it('returns error when target is empty', async () => {
    const result = await runTrivy('image', '', []);
    expect(result).toMatch(/scan type and target are required/i);
  });

  it('returns error when both scanType and target are empty', async () => {
    const result = await runTrivy('', '', []);
    expect(result).toMatch(/scan type and target are required/i);
  });
});

// ---------------------------------------------------------------------------
// Blocked commands (policy rejects before exec)
// ---------------------------------------------------------------------------

describe('runTrivy — blocked commands (no exec)', () => {
  it('blocks trivy server before exec', async () => {
    const result = await runTrivy('server', 'localhost:4954', []);
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks trivy plugin before exec', async () => {
    const result = await runTrivy('plugin', 'install trivy-plugin-aqua', []);
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks unknown scan types (default-deny)', async () => {
    const result = await runTrivy('kubernetes', 'cluster', []);
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks shell metacharacters in extraArgs', async () => {
    const result = await runTrivy('image', 'nginx:latest', ['--severity', 'HIGH; rm -rf /']);
    expect(result).toMatch(BLOCKED_RE);
  });
});

// ---------------------------------------------------------------------------
// Exec paths (mocked node:child_process)
// ---------------------------------------------------------------------------

describe('runTrivy — exec paths (mocked execFile)', () => {
  it('returns stdout for an allowed image scan', async () => {
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: 'Total: 3 (HIGH: 2, CRITICAL: 1)', stderr: '' }));
    const result = await runTrivy('image', 'nginx:latest', []);
    expect(result).toBe('Total: 3 (HIGH: 2, CRITICAL: 1)');
  });

  it('falls back to stderr when stdout is empty', async () => {
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: 'No vulnerabilities found.' }));
    const result = await runTrivy('image', 'nginx:latest', []);
    expect(result).toBe('No vulnerabilities found.');
  });

  it('returns the NO_OUTPUT_MESSAGE when both stdout and stderr are empty', async () => {
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: '' }));
    const result = await runTrivy('fs', '/app', []);
    expect(result).toBe('(trivy produced no output)');
  });

  it('builds argv with -- end-of-flags marker before target', async () => {
    stubExec((_cmd, args, _opts, cb) => {
      expect(args).toContain('--');
      const dashDash = args.indexOf('--');
      expect(args[dashDash + 1]).toBe('nginx:latest');
      cb(null, { stdout: 'ok', stderr: '' });
    });
    await runTrivy('image', 'nginx:latest', []);
  });

  it('places extraArgs before the -- marker', async () => {
    stubExec((_cmd, args, _opts, cb) => {
      expect(args).toEqual(['image', '--severity', 'HIGH', '--', 'nginx:latest']);
      cb(null, { stdout: 'ok', stderr: '' });
    });
    await runTrivy('image', 'nginx:latest', ['--severity', 'HIGH']);
  });

  it('uses "trivy" as the binary name', async () => {
    stubExec((cmd, _args, _opts, cb) => {
      expect(cmd).toBe('trivy');
      cb(null, { stdout: 'ok', stderr: '' });
    });
    await runTrivy('image', 'nginx:latest', []);
  });

  it('applies regex redaction rules to the output', async () => {
    stubExec((_cmd, _args, _opts, cb) =>
      cb(null, { stdout: 'token=secret-abc123 found', stderr: '' }),
    );
    const result = await runTrivy('image', 'nginx:latest', [], {
      regexRedactionRules: [{ name: 'token', re: /token=\S+/g }],
    });
    expect(result).toContain('[REDACTED:token]');
    expect(result).not.toContain('secret-abc123');
  });

  it('uses the provided timeoutMs for exec', async () => {
    stubExec((_cmd, _args, opts, cb) => {
      expect((opts as { timeout?: number }).timeout).toBe(5_000);
      cb(null, { stdout: 'ok', stderr: '' });
    });
    await runTrivy('image', 'nginx:latest', [], { timeoutMs: 5_000 });
  });

  it('uses default timeout when timeoutMs is null', async () => {
    stubExec((_cmd, _args, opts, cb) => {
      expect((opts as { timeout?: number }).timeout).toBe(60_000);
      cb(null, { stdout: 'ok', stderr: '' });
    });
    await runTrivy('image', 'nginx:latest', [], { timeoutMs: null });
  });

  it('handles exit code 1 (vulnerabilities found) and returns stdout', async () => {
    const err = Object.assign(new Error('Command failed: exit code 1'), {
      stdout: 'Total: 5 (CRITICAL: 5)',
      stderr: '',
    });
    stubExec((_cmd, _args, _opts, cb) => cb(err, { stdout: '', stderr: '' }));
    const result = await runTrivy('image', 'nginx:latest', []);
    expect(result).toContain('Total: 5 (CRITICAL: 5)');
  });

  it('returns fallback error when exit code error has no stdout/stderr', async () => {
    const err = new Error('trivy binary not found');
    stubExec((_cmd, _args, _opts, cb) => cb(err, { stdout: '', stderr: '' }));
    const result = await runTrivy('image', 'nginx:latest', []);
    expect(result).toMatch(/trivy exited with an error|trivy binary not found/i);
  });

  it('falls back to String(error) when err.stdout, err.stderr, and err.message are all empty', async () => {
    // Covers the 4th arm of: err.stdout || err.stderr || err.message || String(error)
    const err = Object.assign(new Error(), { stdout: '', stderr: '', message: '' });
    stubExec((_cmd, _args, _opts, cb) => cb(err as unknown as Error, { stdout: '', stderr: '' }));
    const result = await runTrivy('image', 'nginx:latest', []);
    expect(result).toMatch(/trivy|Error/i);
  });

  it('returns the generic error message when detail is empty after redaction', async () => {
    // If String(error).toString() produces '' → detail is '' → if (detail) false → generic message.
    const errLike = Object.assign(Object.create({ toString: () => '' }), {
      stdout: '', stderr: '', message: '',
    });
    stubExec((_cmd, _args, _opts, cb) => cb(errLike as unknown as Error, { stdout: '', stderr: '' }));
    const result = await runTrivy('image', 'nginx:latest', []);
    expect(result).toMatch(/trivy exited with an error/i);
  });

  it('writes audit entry to stderr when audit is enabled', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: 'scan result', stderr: '' }));

    await runTrivy('image', 'nginx:latest', [], { audit: { enabled: true } });

    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[0].trimEnd());
    expect(entry.level).toBe('audit');
    expect(entry.allowed).toBe(true);
    expect(entry.outcome).toBe('ok');
    expect(entry.cmd).toContain('trivy');
  });

  it('truncates output longer than 50 000 characters', async () => {
    const longOutput = 'V'.repeat(100_000);
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: longOutput, stderr: '' }));
    const result = await runTrivy('image', 'nginx:latest', []);
    expect(result.length).toBeLessThan(longOutput.length);
    expect(result).toContain('[output truncated');
  });

  it('allows fs scan type', async () => {
    stubExec((_cmd, args, _opts, cb) => {
      expect(args[0]).toBe('fs');
      cb(null, { stdout: 'fs scan result', stderr: '' });
    });
    const result = await runTrivy('fs', '/app', []);
    expect(result).toBe('fs scan result');
  });

  it('allows config scan type', async () => {
    stubExec((_cmd, args, _opts, cb) => {
      expect(args[0]).toBe('config');
      cb(null, { stdout: 'config scan result', stderr: '' });
    });
    const result = await runTrivy('config', './terraform', []);
    expect(result).toBe('config scan result');
  });
});
