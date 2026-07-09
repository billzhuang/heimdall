import { describe, it, expect } from 'vitest';
import { pluralize } from '../string-utils.ts';

describe('pluralize', () => {
  it('returns the singular form when count is 1', () => {
    expect(pluralize(1, 'entry', 'entries')).toBe('entry');
  });

  it('returns the explicit plural form when count is not 1', () => {
    expect(pluralize(0, 'entry', 'entries')).toBe('entries');
    expect(pluralize(2, 'entry', 'entries')).toBe('entries');
  });

  it('defaults the plural to singular + "s" when omitted', () => {
    expect(pluralize(1, 'scenario')).toBe('scenario');
    expect(pluralize(2, 'scenario')).toBe('scenarios');
    expect(pluralize(0, 'scenario')).toBe('scenarios');
  });
});
