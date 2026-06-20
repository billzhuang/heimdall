/**
 * Tests for runHelm — policy / input validation + mocked exec paths.
 *
 * Real `helm` is NOT invoked. Exec paths are exercised via a vi.mock on
 * node:child_process so we test the full function surface without a cluster.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { runHelm, ALLOWED_HELM_ACTIONS, ALLOWED_HELM_GET_TYPES } from '../helm.ts';

type ExecFileCb = (err: Error | null, result: { stdout: string; stderr: string }) => void;

function stubExec(handler: (cmd: string, args: string[], opts: unknown, cb: ExecFileCb) => void) {
  (execFile as ReturnType<typeof vi.fn>).mockImplementation(handler);
}

beforeEach(() => {
  (execFile as ReturnType<typeof vi.fn>).mockReset();
});

// ---------------------------------------------------------------------------
// Input validation (no exec)
// ---------------------------------------------------------------------------

describe('runHelm — input validation', () => {
  it('requires a release name for the status action', async () => {
    const result = await runHelm('status', {});
    expect(result).toMatch(/release name is required/i);
  });

  it('requires a release name for the get action', async () => {
    const result = await runHelm('get', {});
    expect(result).toMatch(/release name is required/i);
  });

  it('requires getType for the get action', async () => {
    const result = await runHelm('get', { release: 'my-app' });
    expect(result).toMatch(/getType is required/i);
  });

  it('rejects an invalid getType', async () => {
    // @ts-expect-error — deliberately passing a value outside the type
    const result = await runHelm('get', { release: 'my-app', getType: 'install' });
    expect(result).toMatch(/invalid getType/i);
  });

  it('rejects release names starting with a hyphen (option injection)', async () => {
    const result = await runHelm('status', { release: '-evil-release' });
    expect(result).toMatch(/cannot start with a hyphen/i);
  });

  it('rejects namespaces starting with a hyphen (option injection)', async () => {
    const result = await runHelm('list', { namespace: '-evil-namespace' });
    expect(result).toMatch(/cannot start with a hyphen/i);
  });

  it('ALLOWED_HELM_ACTIONS contains exactly list, status, and get', () => {
    expect([...ALLOWED_HELM_ACTIONS].sort()).toEqual(['get', 'list', 'status']);
  });

  it('ALLOWED_HELM_GET_TYPES contains exactly values, manifest, and notes', () => {
    expect([...ALLOWED_HELM_GET_TYPES].sort()).toEqual(['manifest', 'notes', 'values']);
  });
});

// ---------------------------------------------------------------------------
// Exec paths (mocked node:child_process)
// ---------------------------------------------------------------------------

describe('runHelm — exec paths (mocked execFile)', () => {
  it('returns stdout for a list command', async () => {
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: 'NAME  REVISION  STATUS', stderr: '' }));
    const result = await runHelm('list', {});
    expect(result).toBe('NAME  REVISION  STATUS');
  });

  it('falls back to stderr when stdout is empty', async () => {
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: '   ', stderr: 'No releases found.' }));
    const result = await runHelm('list', {});
    expect(result).toBe('No releases found.');
  });

  it('returns no-output message when both stdout and stderr are empty', async () => {
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: '' }));
    const result = await runHelm('list', {});
    expect(result).toBe('(command produced no output)');
  });

  it('builds correct argv for list with namespace', async () => {
    stubExec((_cmd, args, _opts, cb) => {
      expect(args).toEqual(['list', '-n', 'prod']);
      cb(null, { stdout: 'output', stderr: '' });
    });
    await runHelm('list', { namespace: 'prod' });
  });

  it('builds correct argv for list --all-namespaces', async () => {
    stubExec((_cmd, args, _opts, cb) => {
      expect(args).toEqual(['list', '--all-namespaces']);
      cb(null, { stdout: 'output', stderr: '' });
    });
    await runHelm('list', { allNamespaces: true });
  });

  it('builds correct argv for status with namespace', async () => {
    stubExec((_cmd, args, _opts, cb) => {
      expect(args).toEqual(['status', 'my-app', '-n', 'staging']);
      cb(null, { stdout: 'DEPLOYED', stderr: '' });
    });
    await runHelm('status', { release: 'my-app', namespace: 'staging' });
  });

  it('builds correct argv for get values with namespace', async () => {
    stubExec((_cmd, args, _opts, cb) => {
      expect(args).toEqual(['get', 'values', 'my-app', '-n', 'prod']);
      cb(null, { stdout: 'key: value', stderr: '' });
    });
    await runHelm('get', { release: 'my-app', getType: 'values', namespace: 'prod' });
  });

  it('builds correct argv for get manifest', async () => {
    stubExec((_cmd, args, _opts, cb) => {
      expect(args).toEqual(['get', 'manifest', 'my-app']);
      cb(null, { stdout: 'apiVersion: v1', stderr: '' });
    });
    await runHelm('get', { release: 'my-app', getType: 'manifest' });
  });

  it('returns a descriptive error message when helm exits non-zero', async () => {
    const err = Object.assign(new Error('helm failed'), {
      stderr: 'Error: release "nope" not found',
      stdout: '',
    });
    stubExec((_cmd, _args, _opts, cb) => cb(err, { stdout: '', stderr: '' }));
    const result = await runHelm('status', { release: 'nope' });
    expect(result).toMatch(/helm exited with an error/i);
    expect(result).toContain('Error: release "nope" not found');
  });

  it('truncates output longer than 100 000 characters', async () => {
    const longOutput = 'A'.repeat(200_000);
    stubExec((_cmd, _args, _opts, cb) => cb(null, { stdout: longOutput, stderr: '' }));
    const result = await runHelm('list', {});
    expect(result.length).toBeLessThan(longOutput.length);
    expect(result).toContain('[output truncated');
  });

  it('passes the binary name "helm" as the command', async () => {
    stubExec((cmd, _args, _opts, cb) => {
      expect(cmd).toBe('helm');
      cb(null, { stdout: 'ok', stderr: '' });
    });
    await runHelm('list', {});
  });
});
