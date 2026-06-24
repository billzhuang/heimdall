import { describe, it, expect } from 'vitest';
import { makeTruncate } from '../output-truncation.ts';

describe('makeTruncate', () => {
  const truncate = makeTruncate(100, 'use a more specific query');

  it('returns the text unchanged when under the limit', () => {
    const short = 'hello world';
    expect(truncate(short)).toBe(short);
  });

  it('returns the text unchanged when exactly at the limit', () => {
    const exact = 'x'.repeat(100);
    expect(truncate(exact)).toBe(exact);
  });

  it('truncates text over the limit and appends the hint', () => {
    const long = 'x'.repeat(200);
    const result = truncate(long);
    expect(result).toHaveLength(100 + '\n\n[output truncated at 100 characters — use a more specific query]'.length);
    expect(result.startsWith('x'.repeat(100))).toBe(true);
    expect(result).toContain('[output truncated at 100 characters — use a more specific query]');
  });

  it('embeds the character limit in the suffix', () => {
    const truncate50 = makeTruncate(50, 'narrow your query');
    const result = truncate50('y'.repeat(100));
    expect(result).toContain('at 50 characters');
    expect(result).toContain('narrow your query');
  });

  it('different instances use their own limits independently', () => {
    const small = makeTruncate(10, 'hint A');
    const large = makeTruncate(1_000, 'hint B');
    const text = 'z'.repeat(500);
    expect(small(text)).toContain('[output truncated');
    expect(large(text)).toBe(text);
  });
});
