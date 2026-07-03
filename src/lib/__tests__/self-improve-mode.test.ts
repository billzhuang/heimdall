import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSelfImproveArgs } from '../../self-improve-mode.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');
const ENTRY = resolve(ROOT, 'src/self-improve-mode.ts');

function selfImproveMode(...args: string[]) {
  const result = spawnSync(TSX, [ENTRY, ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  return result;
}

describe('heimdall self-improve CLI', () => {
  it('--help exits 0 and prints usage', () => {
    const { status, stdout } = selfImproveMode('--help');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: heimdall self-improve');
    expect(stdout).toContain('--scenario, -s <name>');
    expect(stdout).toContain('--reflect');
  });

  it('-h is an alias for --help', () => {
    const { status, stdout } = selfImproveMode('-h');
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: heimdall self-improve');
  });

  it('exits 1 when --from-log is passed without --reflect', () => {
    const { status, stderr } = selfImproveMode('--from-log');
    expect(status).toBe(1);
    expect(stderr).toContain('--from-log requires --reflect');
  });
});

describe('parseSelfImproveArgs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns defaults for empty args', () => {
    expect(parseSelfImproveArgs([])).toEqual({
      scenarioFilter: undefined,
      reflect: false,
      fromLog: false,
      cliLogPath: undefined,
      logStdout: false,
    });
  });

  it('parses --scenario/-s and --scenario=<value>', () => {
    expect(parseSelfImproveArgs(['--scenario', 'crashloop'])).toMatchObject({ scenarioFilter: 'crashloop' });
    expect(parseSelfImproveArgs(['-s', 'oom'])).toMatchObject({ scenarioFilter: 'oom' });
    expect(parseSelfImproveArgs(['--scenario=crashloop'])).toMatchObject({ scenarioFilter: 'crashloop' });
  });

  it('parses --reflect and --from-log', () => {
    expect(parseSelfImproveArgs(['--reflect'])).toMatchObject({ reflect: true });
    expect(parseSelfImproveArgs(['--from-log'])).toMatchObject({ fromLog: true });
    expect(parseSelfImproveArgs(['--reflect', '--from-log'])).toMatchObject({ reflect: true, fromLog: true });
  });

  it('parses --log-path/-l and --log-path=<value>', () => {
    expect(parseSelfImproveArgs(['--log-path', '/tmp/log.jsonl'])).toMatchObject({ cliLogPath: '/tmp/log.jsonl' });
    expect(parseSelfImproveArgs(['-l', '/tmp/log.jsonl'])).toMatchObject({ cliLogPath: '/tmp/log.jsonl' });
    expect(parseSelfImproveArgs(['--log-path=/tmp/log.jsonl'])).toMatchObject({ cliLogPath: '/tmp/log.jsonl' });
  });

  it('parses --log-stdout', () => {
    expect(parseSelfImproveArgs(['--log-stdout'])).toMatchObject({ logStdout: true });
  });

  it('silently ignores unrecognized flags', () => {
    expect(parseSelfImproveArgs(['--no-such-flag'])).toEqual({
      scenarioFilter: undefined,
      reflect: false,
      fromLog: false,
      cliLogPath: undefined,
      logStdout: false,
    });
  });

  it('parses a combination of flags', () => {
    expect(
      parseSelfImproveArgs(['--scenario', 'oom', '--reflect', '--log-stdout', '--log-path', '/tmp/x.jsonl']),
    ).toEqual({
      scenarioFilter: 'oom',
      reflect: true,
      fromLog: false,
      cliLogPath: '/tmp/x.jsonl',
      logStdout: true,
    });
  });

  it('prints usage and exits 0 for --help/-h', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    parseSelfImproveArgs(['--help']);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: heimdall self-improve'));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
