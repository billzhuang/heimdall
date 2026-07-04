import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseScheduleArgv } from '../../schedule-mode.ts';

describe('parseScheduleArgv', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns runOnce: false for no args', () => {
    expect(parseScheduleArgv([])).toEqual({ runOnce: false });
  });

  it('sets runOnce: true for --once', () => {
    expect(parseScheduleArgv(['--once'])).toEqual({ runOnce: true });
  });

  it('prints usage and exits 0 for --help/-h', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    parseScheduleArgv(['--help']);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: heimdall schedule [--once]'));
    expect(exitSpy).toHaveBeenCalledWith(0);

    parseScheduleArgv(['-h']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 1 with an error for an unknown option', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    parseScheduleArgv(['--bogus']);
    expect(stderrSpy).toHaveBeenCalledWith('Error: unknown option: --bogus\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
