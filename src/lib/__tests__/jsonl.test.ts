import { describe, it, expect, vi, afterEach } from 'vitest';
import { appendJsonlLine, readJsonlFile } from '../jsonl.ts';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises');

const mockReadFile = vi.mocked(fs.readFile);
const mockAppendFile = vi.mocked(fs.appendFile);
const mockMkdir = vi.mocked(fs.mkdir);

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

// ---------------------------------------------------------------------------
// appendJsonlLine
// ---------------------------------------------------------------------------

describe('appendJsonlLine', () => {
  it('calls appendFile with the serialized item and a trailing newline', async () => {
    mockAppendFile.mockResolvedValueOnce(undefined as never);
    await appendJsonlLine({ id: 1, name: 'test' }, '/data.jsonl');
    expect(mockAppendFile).toHaveBeenCalledWith('/data.jsonl', '{"id":1,"name":"test"}\n', 'utf8');
  });

  it('serializes an array value correctly', async () => {
    mockAppendFile.mockResolvedValueOnce(undefined as never);
    await appendJsonlLine([1, 2, 3], '/data.jsonl');
    expect(mockAppendFile).toHaveBeenCalledWith('/data.jsonl', '[1,2,3]\n', 'utf8');
  });

  it('serializes a primitive string value', async () => {
    mockAppendFile.mockResolvedValueOnce(undefined as never);
    await appendJsonlLine('hello world', '/data.jsonl');
    expect(mockAppendFile).toHaveBeenCalledWith('/data.jsonl', '"hello world"\n', 'utf8');
  });

  it('serializes a numeric value', async () => {
    mockAppendFile.mockResolvedValueOnce(undefined as never);
    await appendJsonlLine(42, '/data.jsonl');
    expect(mockAppendFile).toHaveBeenCalledWith('/data.jsonl', '42\n', 'utf8');
  });

  it('propagates non-ENOENT errors thrown by appendFile', async () => {
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    mockAppendFile.mockRejectedValueOnce(err);
    await expect(appendJsonlLine({ id: 1 }, '/protected.jsonl')).rejects.toMatchObject({
      code: 'EACCES',
    });
  });

  it('creates the directory and retries if appendFile throws ENOENT', async () => {
    const enoentErr = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    mockAppendFile.mockRejectedValueOnce(enoentErr);
    mockMkdir.mockResolvedValueOnce(undefined as never);
    mockAppendFile.mockResolvedValueOnce(undefined as never);

    await appendJsonlLine({ id: 1 }, '/nested/dir/data.jsonl');

    expect(mockMkdir).toHaveBeenCalledWith('/nested/dir', { recursive: true });
    expect(mockAppendFile).toHaveBeenCalledTimes(2);
  });

  it('uses the exact filePath provided', async () => {
    mockAppendFile.mockResolvedValueOnce(undefined as never);
    const path = '/custom/dir/log.jsonl';
    await appendJsonlLine({}, path);
    expect(mockAppendFile.mock.calls[0][0]).toBe(path);
  });

  it('throws TypeError for undefined input without calling appendFile', async () => {
    await expect(appendJsonlLine(undefined as never, '/data.jsonl')).rejects.toThrow(TypeError);
    expect(mockAppendFile).not.toHaveBeenCalled();
  });

  it('throws TypeError for function input without calling appendFile', async () => {
    await expect(appendJsonlLine((() => {}) as never, '/data.jsonl')).rejects.toThrow(TypeError);
    expect(mockAppendFile).not.toHaveBeenCalled();
  });
});
