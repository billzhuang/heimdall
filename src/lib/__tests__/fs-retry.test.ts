import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { withMkdirRetry } from '../fs-retry.ts';

vi.mock('node:fs/promises');

const mockMkdir = vi.mocked(fs.mkdir);

afterEach(() => {
  vi.resetAllMocks();
});

describe('withMkdirRetry', () => {
  it('returns the result of op() when it succeeds on the first try', async () => {
    const op = vi.fn().mockResolvedValueOnce('ok');
    const result = await withMkdirRetry('/data/file.jsonl', op);
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
    expect(mockMkdir).not.toHaveBeenCalled();
  });

  it('creates the parent directory and retries once on ENOENT', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const op = vi.fn().mockRejectedValueOnce(enoent).mockResolvedValueOnce('ok');
    mockMkdir.mockResolvedValueOnce(undefined as never);

    const result = await withMkdirRetry('/nested/dir/file.jsonl', op);

    expect(result).toBe('ok');
    expect(mockMkdir).toHaveBeenCalledWith('/nested/dir', { recursive: true });
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('rethrows non-ENOENT errors without attempting mkdir', async () => {
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const op = vi.fn().mockRejectedValueOnce(eacces);

    await expect(withMkdirRetry('/protected/file.jsonl', op)).rejects.toBe(eacces);
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('propagates the error from the retried op() when it also fails', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    const op = vi.fn().mockRejectedValueOnce(enoent).mockRejectedValueOnce(eperm);
    mockMkdir.mockResolvedValueOnce(undefined as never);

    await expect(withMkdirRetry('/nested/dir/file.jsonl', op)).rejects.toBe(eperm);
    expect(op).toHaveBeenCalledTimes(2);
  });
});
