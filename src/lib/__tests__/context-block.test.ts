import { describe, it, expect } from 'vitest';
import { buildContextBlock } from '../context-block.ts';

describe('buildContextBlock', () => {
  it('returns an empty string for an empty entry list', () => {
    expect(buildContextBlock([], 'preamble\n\n', (e: string) => e)).toBe('');
  });

  it('prefixes the preamble and formats a single entry', () => {
    const result = buildContextBlock(['a'], 'preamble\n\n', (e) => `[${e}]`);
    expect(result).toBe('preamble\n\n[a]');
  });

  it('joins multiple formatted entries with a blank line', () => {
    const result = buildContextBlock(['a', 'b', 'c'], 'preamble\n\n', (e) => `[${e}]`);
    expect(result).toBe('preamble\n\n[a]\n\n[b]\n\n[c]');
  });

  it('passes the index to formatEntry', () => {
    const result = buildContextBlock(['a', 'b'], '', (e, i) => `${i}:${e}`);
    expect(result).toBe('0:a\n\n1:b');
  });
});
