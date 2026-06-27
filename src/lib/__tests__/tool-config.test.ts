import { describe, it, expect } from 'vitest';
import { resolveTimeoutMs } from '../tool-config.ts';

describe('resolveTimeoutMs', () => {
  it('returns the provided value when it is a positive finite number', () => {
    expect(resolveTimeoutMs(5_000, 15_000)).toBe(5_000);
    expect(resolveTimeoutMs(1, 15_000)).toBe(1);
    expect(resolveTimeoutMs(0.5, 15_000)).toBe(0.5);
  });

  it('returns defaultMs when rawTimeout is zero', () => {
    expect(resolveTimeoutMs(0, 15_000)).toBe(15_000);
  });

  it('returns defaultMs when rawTimeout is negative', () => {
    expect(resolveTimeoutMs(-1, 15_000)).toBe(15_000);
    expect(resolveTimeoutMs(-Infinity, 15_000)).toBe(15_000);
  });

  it('returns defaultMs when rawTimeout is Infinity', () => {
    expect(resolveTimeoutMs(Infinity, 15_000)).toBe(15_000);
  });

  it('returns defaultMs when rawTimeout is NaN', () => {
    expect(resolveTimeoutMs(NaN, 15_000)).toBe(15_000);
  });

  it('returns defaultMs when rawTimeout is null', () => {
    expect(resolveTimeoutMs(null, 15_000)).toBe(15_000);
  });

  it('returns defaultMs when rawTimeout is undefined', () => {
    expect(resolveTimeoutMs(undefined, 15_000)).toBe(15_000);
  });
});
