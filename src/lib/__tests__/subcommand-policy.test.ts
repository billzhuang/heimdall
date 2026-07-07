import { describe, it, expect } from 'vitest';
import { classifySubcommand } from '../subcommand-policy.ts';

describe('classifySubcommand', () => {
  it('returns "destructive" when the destructive match wins', () => {
    expect(classifySubcommand(true, false)).toBe('destructive');
  });

  it('returns "allowed" when only the allow-list matches', () => {
    expect(classifySubcommand(false, true)).toBe('allowed');
  });

  it('returns "unknown" when neither list matches (default-deny)', () => {
    expect(classifySubcommand(false, false)).toBe('unknown');
  });

  it('prefers "destructive" over "allowed" when both match', () => {
    expect(classifySubcommand(true, true)).toBe('destructive');
  });
});
