import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockProcessExit } from './test-helpers.ts';
import {
  die,
  requireNextArg,
  requireNonEmptyValue,
  parseCommaSeparatedList,
  parseModelFlag,
  parseRequiredFlag,
  parseAliasedFlag,
  isMainModule,
  resolveModelOrExit,
  handleHelpOrUnknownOption,
  runMainOrExit,
} from '../cli-args.ts';

describe('die', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes "Error: <msg>" to stderr and exits with the given code', () => {
    const { stderrSpy, exitSpy } = mockProcessExit();
    die('something went wrong', 2);
    expect(stderrSpy).toHaveBeenCalledWith('Error: something went wrong\n');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('defaults to exit code 1', () => {
    const { stderrSpy, exitSpy } = mockProcessExit();
    die('boom');
    expect(stderrSpy).toHaveBeenCalledWith('Error: boom\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

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
    const { stderrSpy, exitSpy } = mockProcessExit();
    requireNextArg(['--namespace'], 0, '--namespace requires a value');
    expect(stderrSpy).toHaveBeenCalledWith('Error: --namespace requires a value\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes error and exits when the next token starts with "-"', () => {
    const { stderrSpy, exitSpy } = mockProcessExit();
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
    const { stderrSpy, exitSpy } = mockProcessExit();
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
    const { stderrSpy, exitSpy } = mockProcessExit();
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
    const { stderrSpy, exitSpy } = mockProcessExit();
    parseModelFlag(['-m'], 0, ['--model', '-m']);
    expect(stderrSpy).toHaveBeenCalledWith('Error: -m requires a value\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes an error and exits when the next token looks like a flag', () => {
    const { stderrSpy, exitSpy } = mockProcessExit();
    parseModelFlag(['--model', '--other'], 0);
    expect(stderrSpy).toHaveBeenCalledWith('Error: --model requires a value\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes an error and exits when "--model=" has an empty value', () => {
    const { stderrSpy, exitSpy } = mockProcessExit();
    parseModelFlag(['--model='], 0);
    expect(stderrSpy).toHaveBeenCalledWith('Error: --model= requires a non-empty value\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('parseRequiredFlag', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses the space-separated form and advances the index past the value', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const args = ['--namespace', 'prod'];
    expect(parseRequiredFlag(args, 0, '--namespace=', 'missing', 'empty')).toEqual({
      value: 'prod',
      nextIndex: 1,
      usedEquals: false,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('parses the "=" form without advancing the index', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const args = ['--namespace=prod'];
    expect(parseRequiredFlag(args, 0, '--namespace=', 'missing', 'empty')).toEqual({
      value: 'prod',
      nextIndex: 0,
      usedEquals: true,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('writes the space-form error and exits when the next token is missing', () => {
    const { stderrSpy, exitSpy } = mockProcessExit();
    parseRequiredFlag(['--namespace'], 0, '--namespace=', '--namespace requires a namespace argument', 'empty');
    expect(stderrSpy).toHaveBeenCalledWith('Error: --namespace requires a namespace argument\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes the space-form error and exits when the next token looks like a flag', () => {
    const { stderrSpy, exitSpy } = mockProcessExit();
    parseRequiredFlag(['--namespace', '--other'], 0, '--namespace=', '--namespace requires a namespace argument', 'empty');
    expect(stderrSpy).toHaveBeenCalledWith('Error: --namespace requires a namespace argument\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes the "=" form error and exits when the value is empty', () => {
    const { stderrSpy, exitSpy } = mockProcessExit();
    parseRequiredFlag(['--namespace='], 0, '--namespace=', 'missing', '--namespace= requires a non-empty value');
    expect(stderrSpy).toHaveBeenCalledWith('Error: --namespace= requires a non-empty value\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('accepts an empty "=" form value when equalsEmptyMsg is omitted', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    expect(parseRequiredFlag(['--name='], 0, '--name=', 'missing')).toEqual({
      value: '',
      nextIndex: 0,
      usedEquals: true,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('parseAliasedFlag', () => {
  it('parses "--long <value>" and advances the index past the value', () => {
    expect(parseAliasedFlag(['--scenario', 'oom'], 0, '--scenario', '-s')).toEqual({
      value: 'oom',
      nextIndex: 1,
    });
  });

  it('parses "-short <value>" and advances the index past the value', () => {
    expect(parseAliasedFlag(['-s', 'oom'], 0, '--scenario', '-s')).toEqual({
      value: 'oom',
      nextIndex: 1,
    });
  });

  it('parses "--long=<value>" without advancing the index', () => {
    expect(parseAliasedFlag(['--scenario=oom'], 0, '--scenario', '-s')).toEqual({
      value: 'oom',
      nextIndex: 0,
    });
  });

  it('returns undefined when args[i] does not match the long or short flag', () => {
    expect(parseAliasedFlag(['--other', 'oom'], 0, '--scenario', '-s')).toBeUndefined();
  });

  it('returns undefined when the long/short flag has no following value', () => {
    expect(parseAliasedFlag(['--scenario'], 0, '--scenario', '-s')).toBeUndefined();
  });

  it('works without a short alias', () => {
    expect(parseAliasedFlag(['--backend', 'codex-cli'], 0, '--backend')).toEqual({
      value: 'codex-cli',
      nextIndex: 1,
    });
    expect(parseAliasedFlag(['--backend=codex-cli'], 0, '--backend')).toEqual({
      value: 'codex-cli',
      nextIndex: 0,
    });
  });
});

describe('resolveModelOrExit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the resolved model for a valid "provider/model" flag', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    expect(resolveModelOrExit('anthropic/claude-opus-4-8')).toBe('anthropic/claude-opus-4-8');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('falls back to the default model when no flag is passed', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    expect(resolveModelOrExit()).toContain('/');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('writes the underlying error and exits(1) for an invalid specifier', () => {
    const { stderrSpy, exitSpy } = mockProcessExit();
    resolveModelOrExit('badmodel');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Error: Invalid model "badmodel"'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('handleHelpOrUnknownOption', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the help text and exits 0 for --help', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    handleHelpOrUnknownOption('--help', 'Usage: some-mode [options]\n');
    expect(stdoutSpy).toHaveBeenCalledWith('Usage: some-mode [options]\n');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('prints the help text and exits 0 for -h', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    handleHelpOrUnknownOption('-h', 'Usage: some-mode [options]\n');
    expect(stdoutSpy).toHaveBeenCalledWith('Usage: some-mode [options]\n');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('writes an unknown-option error and exits 1, without touching stdout, for anything else', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { stderrSpy, exitSpy } = mockProcessExit();
    handleHelpOrUnknownOption('--bogus', 'Usage: some-mode [options]\n');
    expect(stderrSpy).toHaveBeenCalledWith('Error: unknown option: --bogus\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});

describe('runMainOrExit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not write to stderr or exit when the promise resolves', async () => {
    const { stderrSpy, exitSpy } = mockProcessExit();
    await runMainOrExit(Promise.resolve(), '[heimdall-test] Fatal error');
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('writes "<prefix>: <stack or message>" to stderr and exits(1) when the promise rejects', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    await expect(
      runMainOrExit(Promise.reject(new Error('boom')), '[heimdall-test] Fatal error'),
    ).rejects.toThrow('process.exit');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[heimdall-test] Fatal error: '));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('preserves the given prefix verbatim (per-mode tag and wording)', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    await expect(runMainOrExit(Promise.reject('oops'), '[heimdall-alert] Fatal')).rejects.toThrow('process.exit');
    expect(stderrSpy).toHaveBeenCalledWith('[heimdall-alert] Fatal: oops\n');
  });
});

describe('isMainModule', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when the file URL resolves to process.argv[1]', () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', '/repo/src/some-mode.ts']);
    expect(isMainModule('file:///repo/src/some-mode.ts')).toBe(true);
  });

  it('returns false when process.argv[1] points at a different file (e.g. imported by a test runner)', () => {
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', '/repo/node_modules/.bin/vitest']);
    expect(isMainModule('file:///repo/src/some-mode.ts')).toBe(false);
  });
});
