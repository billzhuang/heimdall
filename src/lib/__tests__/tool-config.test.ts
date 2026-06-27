import { describe, it, expect } from 'vitest';
import { resolveTimeoutMs, clampLimit } from '../tool-config.ts';

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

describe('clampLimit', () => {
  it('returns the value unchanged when it is a positive finite integer within range', () => {
    expect(clampLimit(50, 20, 100)).toBe(50);
    expect(clampLimit(1, 20, 100)).toBe(1);
    expect(clampLimit(100, 20, 100)).toBe(100);
  });

  it('clamps to maxLimit when rawLimit exceeds it', () => {
    expect(clampLimit(150, 20, 100)).toBe(100);
    expect(clampLimit(10_000, 20, 100)).toBe(100);
  });

  it('truncates fractional values before clamping', () => {
    expect(clampLimit(2.9, 20, 100)).toBe(2);
    expect(clampLimit(0.9, 20, 100)).toBe(1);
  });

  it('clamps to 1 for zero', () => {
    expect(clampLimit(0, 20, 100)).toBe(1);
  });

  it('clamps to 1 for negative numbers (not defaultLimit)', () => {
    expect(clampLimit(-5, 20, 100)).toBe(1);
    expect(clampLimit(-1, 20, 100)).toBe(1);
  });

  it('returns defaultLimit for null', () => {
    expect(clampLimit(null, 20, 100)).toBe(20);
  });

  it('returns defaultLimit for undefined', () => {
    expect(clampLimit(undefined, 20, 100)).toBe(20);
  });

  it('returns defaultLimit for NaN', () => {
    expect(clampLimit(NaN, 20, 100)).toBe(20);
  });

  it('returns defaultLimit for Infinity', () => {
    expect(clampLimit(Infinity, 20, 100)).toBe(20);
    expect(clampLimit(-Infinity, 20, 100)).toBe(20);
  });
});
