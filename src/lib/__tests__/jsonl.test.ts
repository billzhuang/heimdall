import { describe, it, expect, vi, afterEach } from 'vitest';
import { readJsonlFile } from '../jsonl.ts';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises');

const mockReadFile = vi.mocked(fs.readFile);

afterEach(() => {
  vi.resetAllMocks();
});

describe('readJsonlFile', () => {
  it('returns [] when the file does not exist', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockReadFile.mockRejectedValueOnce(err);
    const result = await readJsonlFile('/no/such/file.jsonl');
    expect(result).toEqual([]);
  });

  it('rethrows non-ENOENT errors', async () => {
    const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    mockReadFile.mockRejectedValueOnce(err);
    await expect(readJsonlFile('/protected/file.jsonl')).rejects.toThrow('EACCES');
  });

  it('parses valid JSONL and returns typed entries', async () => {
    mockReadFile.mockResolvedValueOnce('{"id":1}\n{"id":2}\n' as never);
    const result = await readJsonlFile<{ id: number }>('/data.jsonl');
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('skips empty lines', async () => {
    mockReadFile.mockResolvedValueOnce('\n{"id":1}\n\n{"id":2}\n\n' as never);
    const result = await readJsonlFile<{ id: number }>('/data.jsonl');
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('skips malformed lines silently when no onSkip provided', async () => {
    mockReadFile.mockResolvedValueOnce('{"id":1}\nnot-json\n{"id":2}\n' as never);
    const result = await readJsonlFile<{ id: number }>('/data.jsonl');
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('calls onSkip with the malformed line content', async () => {
    mockReadFile.mockResolvedValueOnce('{"id":1}\nbad-line\n{"id":2}\n' as never);
    const onSkip = vi.fn();
    const result = await readJsonlFile<{ id: number }>('/data.jsonl', onSkip);
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    expect(onSkip).toHaveBeenCalledOnce();
    expect(onSkip).toHaveBeenCalledWith('bad-line');
  });

  it('returns [] for a file with only empty lines', async () => {
    mockReadFile.mockResolvedValueOnce('\n\n\n' as never);
    const result = await readJsonlFile('/data.jsonl');
    expect(result).toEqual([]);
  });
});
