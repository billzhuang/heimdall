import { describe, it, expect } from 'vitest';
import { isPlainObject, optionalString } from '../json-utils.ts';

describe('isPlainObject', () => {
  it('accepts plain objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it('rejects null, arrays, and non-objects', () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(['a', 'b'])).toBe(false);
    expect(isPlainObject('a string')).toBe(false);
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject(true)).toBe(false);
  });
});

describe('optionalString', () => {
  it('returns the value when it is a string', () => {
    expect(optionalString('hello')).toBe('hello');
    expect(optionalString('')).toBe('');
  });

  it('returns undefined for non-string values', () => {
    expect(optionalString(42)).toBeUndefined();
    expect(optionalString(null)).toBeUndefined();
    expect(optionalString(undefined)).toBeUndefined();
    expect(optionalString({})).toBeUndefined();
    expect(optionalString([])).toBeUndefined();
  });
});
