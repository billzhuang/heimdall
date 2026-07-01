import { describe, it, expect } from 'vitest';
import { resolveModel, resolveModelOrUndefined } from '../model.ts';

describe('resolveModel', () => {
  it('returns the CLI flag unchanged for a valid provider/model string', () => {
    expect(resolveModel('anthropic/claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6');
    expect(resolveModel('openai/gpt-4o')).toBe('openai/gpt-4o');
  });

  it('falls back to DEFAULT_MODEL when cliFlag is undefined', () => {
    expect(() => resolveModel()).not.toThrow();
    expect(resolveModel()).toContain('/');
  });

  it('falls back to DEFAULT_MODEL when cliFlag is empty string', () => {
    expect(() => resolveModel('')).not.toThrow();
    expect(resolveModel('')).toContain('/');
  });

  it('throws for "/" (empty provider and empty model)', () => {
    expect(() => resolveModel('/')).toThrow(/Invalid model/);
  });

  it('throws when provider part is empty', () => {
    expect(() => resolveModel('/claude-sonnet-4-6')).toThrow(/Invalid model/);
  });

  it('throws when model part is empty', () => {
    expect(() => resolveModel('anthropic/')).toThrow(/Invalid model/);
  });

  it('throws when there is no slash', () => {
    expect(() => resolveModel('anthropic')).toThrow(/Invalid model/);
  });

  it('includes the invalid model string in the error message', () => {
    expect(() => resolveModel('badmodel')).toThrow(/badmodel/);
    expect(() => resolveModel('/')).toThrow(/"\/"/);
  });
});

describe('resolveModelOrUndefined', () => {
  it('returns the resolved model for a valid provider/model string', () => {
    expect(resolveModelOrUndefined('anthropic/claude-sonnet-4-6')).toBe(
      'anthropic/claude-sonnet-4-6',
    );
  });

  it('falls back to DEFAULT_MODEL when cliFlag is undefined', () => {
    expect(resolveModelOrUndefined()).toBe(resolveModel());
  });

  it('returns undefined instead of throwing for an invalid model string', () => {
    expect(resolveModelOrUndefined('badmodel')).toBeUndefined();
    expect(resolveModelOrUndefined('/')).toBeUndefined();
  });
});
