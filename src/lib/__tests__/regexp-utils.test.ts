import { describe, it, expect } from 'vitest';
import { escapeRegExpLiteral } from '../regexp-utils.ts';

describe('escapeRegExpLiteral', () => {
  it('escapes every regex special character', () => {
    expect(escapeRegExpLiteral('.*+?^${}()|[]\\')).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
  });

  it('leaves plain alphanumeric text untouched', () => {
    expect(escapeRegExpLiteral('prod-namespace_1')).toBe('prod-namespace_1');
  });

  it('produces a pattern that matches the literal input string', () => {
    const raw = 'my.ns[0]+(prod)';
    const re = new RegExp(`^${escapeRegExpLiteral(raw)}$`);
    expect(re.test(raw)).toBe(true);
    expect(re.test('myXns[0]+(prod)')).toBe(false);
  });

  it('returns an empty string unchanged', () => {
    expect(escapeRegExpLiteral('')).toBe('');
  });
});
