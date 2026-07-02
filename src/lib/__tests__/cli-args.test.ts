import { describe, it, expect, vi, afterEach } from 'vitest';
import { requireNextArg, requireNonEmptyValue } from '../cli-args.ts';

describe('requireNextArg', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not exit when the next token exists and is not a flag', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    requireNextArg(['--namespace', 'prod'], 0, '--namespace requires a value');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('writes error and exits when there is no next token', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    requireNextArg(['--namespace'], 0, '--namespace requires a value');
    expect(stderrSpy).toHaveBeenCalledWith('Error: --namespace requires a value\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes error and exits when the next token starts with "-"', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    requireNextArg(['--namespace', '--model'], 0, '--namespace requires a value');
    expect(stderrSpy).toHaveBeenCalledWith('Error: --namespace requires a value\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('accepts values that start with a hyphen-like but are not flags', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    requireNextArg(['--model', 'anthropic/claude-sonnet-4-6'], 0, '--model requires a value');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('requireNonEmptyValue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not exit when value is a non-empty string', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    requireNonEmptyValue('prod', '--namespace= requires a non-empty value');
    requireNonEmptyValue('cluster-a,cluster-b', '--contexts= requires a non-empty value');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('writes error and exits when value is an empty string', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    requireNonEmptyValue('', '--model= requires a non-empty value');
    expect(stderrSpy).toHaveBeenCalledWith('Error: --model= requires a non-empty value\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
