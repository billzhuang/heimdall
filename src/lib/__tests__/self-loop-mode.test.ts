import { describe, it, expect, vi, afterEach } from 'vitest';
import { requirePositiveInt } from '../../self-loop-mode.ts';

describe('requirePositiveInt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns without error for a valid positive integer', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    requirePositiveInt(1, 'flag must be a positive integer');
    requirePositiveInt(5, 'flag must be a positive integer');
    requirePositiveInt(100, 'flag must be a positive integer');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('writes the error message and exits for NaN', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    requirePositiveInt(NaN, 'flag must be a positive integer');
    expect(stderrSpy).toHaveBeenCalledWith('Error: flag must be a positive integer\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes the error message and exits for zero', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    requirePositiveInt(0, 'flag must be a positive integer');
    expect(stderrSpy).toHaveBeenCalledWith('Error: flag must be a positive integer\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes the error message and exits for a negative integer', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    requirePositiveInt(-3, 'flag must be a positive integer');
    expect(stderrSpy).toHaveBeenCalledWith('Error: flag must be a positive integer\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('includes the "(seconds)" suffix in the error message when provided', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    requirePositiveInt(NaN, '--timeout must be a positive integer (seconds)');
    expect(stderrSpy).toHaveBeenCalledWith('Error: --timeout must be a positive integer (seconds)\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
