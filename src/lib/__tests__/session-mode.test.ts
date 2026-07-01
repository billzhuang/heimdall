/**
 * Unit tests for parseSessionIdArg — pins the session-id resolution shared by
 * `heimdall session info <id>` and `heimdall session end <id>`.
 */
import { describe, it, expect } from 'vitest';
import { parseSessionIdArg } from '../../session-mode.ts';

describe('parseSessionIdArg', () => {
  it('resolves a positional argument', () => {
    expect(parseSessionIdArg(['abc-123'])).toBe('abc-123');
  });

  it('resolves --session <id>', () => {
    expect(parseSessionIdArg(['--session', 'abc-123'])).toBe('abc-123');
  });

  it('resolves -s <id>', () => {
    expect(parseSessionIdArg(['-s', 'abc-123'])).toBe('abc-123');
  });

  it('resolves --session=<id>', () => {
    expect(parseSessionIdArg(['--session=abc-123'])).toBe('abc-123');
  });

  it('returns undefined when no id is present', () => {
    expect(parseSessionIdArg([])).toBeUndefined();
    expect(parseSessionIdArg(['--foo'])).toBeUndefined();
  });

  it('prefers an explicit --session flag over a positional argument', () => {
    expect(parseSessionIdArg(['positional-id', '--session', 'flag-id'])).toBe('flag-id');
  });
});
