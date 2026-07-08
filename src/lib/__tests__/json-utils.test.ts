import { describe, it, expect } from 'vitest';
import { isPlainObject, optionalString, requireNonEmptyStringField } from '../json-utils.ts';

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

describe('requireNonEmptyStringField', () => {
  it('returns the trimmed value when the field is a non-empty string', () => {
    expect(requireNonEmptyStringField({ prompt: '  hello  ' }, 'prompt')).toEqual({
      ok: true,
      value: 'hello',
    });
  });

  it('errors when the field is missing', () => {
    expect(requireNonEmptyStringField({}, 'prompt')).toEqual({
      ok: false,
      error: '"prompt" is required and must be a non-empty string',
    });
  });

  it('errors when the field is whitespace-only', () => {
    expect(requireNonEmptyStringField({ prompt: '   ' }, 'prompt')).toEqual({
      ok: false,
      error: '"prompt" is required and must be a non-empty string',
    });
  });

  it('errors when the field is not a string', () => {
    expect(requireNonEmptyStringField({ prompt: 42 }, 'prompt')).toEqual({
      ok: false,
      error: '"prompt" is required and must be a non-empty string',
    });
  });

  it('interpolates the field name into the error message', () => {
    expect(requireNonEmptyStringField({}, 'inputText')).toEqual({
      ok: false,
      error: '"inputText" is required and must be a non-empty string',
    });
  });
});
