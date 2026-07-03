import { describe, it, expect, vi, afterEach } from 'vitest';
import { requireNextArg, requireNonEmptyValue, parseCommaSeparatedList, parseModelFlag } from '../cli-args.ts';

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

describe('parseCommaSeparatedList', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('splits, trims, and returns the list', () => {
    expect(parseCommaSeparatedList('cluster-a, cluster-b ,cluster-c', 'empty')).toEqual([
      'cluster-a',
      'cluster-b',
      'cluster-c',
    ]);
  });

  it('drops empty tokens from repeated or trailing commas', () => {
    expect(parseCommaSeparatedList('cluster-a,,cluster-b,', 'empty')).toEqual(['cluster-a', 'cluster-b']);
  });

  it('dedupes repeated values while preserving first-seen order', () => {
    expect(parseCommaSeparatedList('cluster-a,cluster-b,cluster-a', 'empty')).toEqual(['cluster-a', 'cluster-b']);
  });

  it('writes error and exits when nothing survives filtering', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    parseCommaSeparatedList(' , ,', '--contexts value produced an empty list after parsing');
    expect(stderrSpy).toHaveBeenCalledWith('Error: --contexts value produced an empty list after parsing\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('parseModelFlag', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses "--model <value>" and advances the index past the value', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const args = ['--model', 'anthropic/claude-sonnet-4-6'];
    expect(parseModelFlag(args, 0)).toEqual({ value: 'anthropic/claude-sonnet-4-6', nextIndex: 1 });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('parses "--model=<value>" without advancing the index', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const args = ['--model=anthropic/claude-sonnet-4-6'];
    expect(parseModelFlag(args, 0)).toEqual({ value: 'anthropic/claude-sonnet-4-6', nextIndex: 0 });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('accepts a custom alias (e.g. "-m")', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const args = ['-m', 'anthropic/claude-sonnet-4-6'];
    expect(parseModelFlag(args, 0, ['--model', '-m'])).toEqual({
      value: 'anthropic/claude-sonnet-4-6',
      nextIndex: 1,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('writes an alias-specific error and exits when the value is missing', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    parseModelFlag(['-m'], 0, ['--model', '-m']);
    expect(stderrSpy).toHaveBeenCalledWith('Error: -m requires a value\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes an error and exits when the next token looks like a flag', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    parseModelFlag(['--model', '--other'], 0);
    expect(stderrSpy).toHaveBeenCalledWith('Error: --model requires a value\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes an error and exits when "--model=" has an empty value', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    parseModelFlag(['--model='], 0);
    expect(stderrSpy).toHaveBeenCalledWith('Error: --model= requires a non-empty value\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
