import { describe, it, expect, vi, afterEach } from 'vitest';
import { appendJsonlLine, generateEntryId, readJsonlFile, readJsonlFileSync, writeJsonlFile } from '../jsonl.ts';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';

vi.mock('node:fs/promises');
vi.mock('node:fs');

const mockReadFile = vi.mocked(fs.readFile);
const mockAppendFile = vi.mocked(fs.appendFile);
const mockWriteFile = vi.mocked(fs.writeFile);
const mockMkdir = vi.mocked(fs.mkdir);
const mockReadFileSync = vi.mocked(fsSync.readFileSync);

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
// readJsonlFileSync
// ---------------------------------------------------------------------------

describe('readJsonlFileSync', () => {
  it('returns [] when the file does not exist', () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockReadFileSync.mockImplementationOnce(() => {
      throw err;
    });
    expect(readJsonlFileSync('/no/such/file.jsonl')).toEqual([]);
  });

  it('returns [] and swallows non-ENOENT errors when no onError is provided', () => {
    const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    mockReadFileSync.mockImplementationOnce(() => {
      throw err;
    });
    expect(readJsonlFileSync('/protected.jsonl')).toEqual([]);
  });

  it('reports non-ENOENT errors via onError and returns []', () => {
    const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    mockReadFileSync.mockImplementationOnce(() => {
      throw err;
    });
    const onError = vi.fn();
    expect(readJsonlFileSync('/protected.jsonl', { onError })).toEqual([]);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('does not call onError for ENOENT', () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockReadFileSync.mockImplementationOnce(() => {
      throw err;
    });
    const onError = vi.fn();
    expect(readJsonlFileSync('/no/such/file.jsonl', { onError })).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('parses valid JSONL and returns typed entries', () => {
    mockReadFileSync.mockReturnValueOnce('{"id":1}\n{"id":2}\n' as never);
    const result = readJsonlFileSync<{ id: number }>('/data.jsonl');
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('skips empty lines', () => {
    mockReadFileSync.mockReturnValueOnce('\n{"id":1}\n\n{"id":2}\n\n' as never);
    const result = readJsonlFileSync<{ id: number }>('/data.jsonl');
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('drops malformed lines silently', () => {
    mockReadFileSync.mockReturnValueOnce('{"id":1}\nnot-json\n{"id":2}\n' as never);
    const result = readJsonlFileSync<{ id: number }>('/data.jsonl');
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('drops non-object parsed values (e.g. bare numbers/strings)', () => {
    mockReadFileSync.mockReturnValueOnce('{"id":1}\n42\n"hi"\nnull\n{"id":2}\n' as never);
    const result = readJsonlFileSync<{ id: number }>('/data.jsonl');
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('returns [] for a file with only empty lines', () => {
    mockReadFileSync.mockReturnValueOnce('\n\n\n' as never);
    expect(readJsonlFileSync('/data.jsonl')).toEqual([]);
  });

  it('keeps only the last N non-empty lines when tail is set', () => {
    mockReadFileSync.mockReturnValueOnce('{"id":1}\n{"id":2}\n{"id":3}\n' as never);
    const result = readJsonlFileSync<{ id: number }>('/data.jsonl', { tail: 2 });
    expect(result).toEqual([{ id: 2 }, { id: 3 }]);
  });

  it('applies tail before parsing, so malformed lines within the window still drop', () => {
    mockReadFileSync.mockReturnValueOnce('{"id":1}\nnot-json\n{"id":3}\n' as never);
    const result = readJsonlFileSync<{ id: number }>('/data.jsonl', { tail: 2 });
    expect(result).toEqual([{ id: 3 }]);
  });

  it('returns [] when tail is explicitly 0', () => {
    mockReadFileSync.mockReturnValueOnce('{"id":1}\n{"id":2}\n' as never);
    const result = readJsonlFileSync<{ id: number }>('/data.jsonl', { tail: 0 });
    expect(result).toEqual([]);
  });

  it('is a no-op cap when tail exceeds the number of lines', () => {
    mockReadFileSync.mockReturnValueOnce('{"id":1}\n{"id":2}\n' as never);
    const result = readJsonlFileSync<{ id: number }>('/data.jsonl', { tail: 100 });
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
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

// ---------------------------------------------------------------------------
// writeJsonlFile
// ---------------------------------------------------------------------------

describe('writeJsonlFile', () => {
  it('writes items as JSONL with a trailing newline', async () => {
    mockWriteFile.mockResolvedValueOnce(undefined as never);
    await writeJsonlFile([{ id: 1 }, { id: 2 }], '/data.jsonl');
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/data.jsonl',
      '{"id":1}\n{"id":2}\n',
      'utf8',
    );
  });

  it('writes an empty string for an empty items array', async () => {
    mockWriteFile.mockResolvedValueOnce(undefined as never);
    await writeJsonlFile([], '/data.jsonl');
    expect(mockWriteFile).toHaveBeenCalledWith('/data.jsonl', '', 'utf8');
  });

  it('creates the parent directory and retries when writeFile throws ENOENT', async () => {
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockWriteFile.mockRejectedValueOnce(enoentErr);
    mockMkdir.mockResolvedValueOnce(undefined as never);
    mockWriteFile.mockResolvedValueOnce(undefined as never);

    await writeJsonlFile([{ id: 1 }], '/nested/dir/data.jsonl');

    expect(mockMkdir).toHaveBeenCalledWith('/nested/dir', { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledTimes(2);
  });

  it('propagates non-ENOENT errors thrown by writeFile', async () => {
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    mockWriteFile.mockRejectedValueOnce(err);
    await expect(writeJsonlFile([{ id: 1 }], '/protected.jsonl')).rejects.toMatchObject({
      code: 'EACCES',
    });
  });
});

// ---------------------------------------------------------------------------
// generateEntryId
// ---------------------------------------------------------------------------

describe('generateEntryId', () => {
  it('returns an id matching "<unix-ms>-<12-hex-chars>" and an ISO-8601 timestamp', () => {
    const before = Date.now();
    const { id, timestamp } = generateEntryId();
    const after = Date.now();

    expect(id).toMatch(/^\d+-[0-9a-f]{12}$/);
    const ms = parseInt(id.split('-')[0], 10);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('returns unique ids on successive calls', () => {
    const ids = Array.from({ length: 5 }, () => generateEntryId().id);
    expect(new Set(ids).size).toBe(5);
  });
});
