import { describe, it, expect } from 'vitest';
import { parseSessionIdArg } from '../../session-mode.ts';

describe('parseSessionIdArg', () => {
  it('returns the first positional argument as the session id', () => {
    expect(parseSessionIdArg(['abc-123'])).toBe('abc-123');
  });

  it('returns undefined when no args are given', () => {
    expect(parseSessionIdArg([])).toBeUndefined();
  });

  it('returns undefined when only flags are given', () => {
    expect(parseSessionIdArg(['--verbose'])).toBeUndefined();
  });

  it('honors --session <id>', () => {
    expect(parseSessionIdArg(['--session', 'abc-123'])).toBe('abc-123');
  });

  it('honors -s <id>', () => {
    expect(parseSessionIdArg(['-s', 'abc-123'])).toBe('abc-123');
  });

  it('honors --session=<id>', () => {
    expect(parseSessionIdArg(['--session=abc-123'])).toBe('abc-123');
  });

  it('prefers an explicit --session flag over a positional argument', () => {
    expect(parseSessionIdArg(['positional-id', '--session', 'flag-id'])).toBe('flag-id');
  });

  it('prefers an explicit -s flag over a positional argument', () => {
    expect(parseSessionIdArg(['positional-id', '-s', 'flag-id'])).toBe('flag-id');
  });

  it('returns undefined for empty or falsy session IDs', () => {
    expect(parseSessionIdArg([''])).toBeUndefined();
    expect(parseSessionIdArg(['--session='])).toBeUndefined();
    expect(parseSessionIdArg(['--session', ''])).toBeUndefined();
  });

  it('rejects a dangling --session/-s (no trailing value) rather than falling back to a positional id', () => {
    expect(parseSessionIdArg(['abc-123', '-s'])).toBeUndefined();
    expect(parseSessionIdArg(['abc-123', '--session'])).toBeUndefined();
  });
});
