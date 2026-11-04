import { describe, it, expect, vi } from 'vitest';
import { parsePiRunnerArgs, runPiAgentPrompt } from '../../pi-runner.ts';
import type { DefinedAgent } from '../pi-durable.ts';

describe('parsePiRunnerArgs', () => {
  it('parses -p, --prompt, --model, and --sqlite flags', () => {
    expect(
      parsePiRunnerArgs(['-p', 'Why is api crashing?', '--model', 'anthropic/claude-opus-4-8', '--sqlite', '/tmp/s.db']),
    ).toEqual({
      prompt: 'Why is api crashing?',
      modelFlag: 'anthropic/claude-opus-4-8',
      sqlitePath: '/tmp/s.db',
    });

    expect(
      parsePiRunnerArgs(['--prompt=Check nodes', '--model=openai/gpt-5', '--sqlite=/tmp/a.db']),
    ).toEqual({
      prompt: 'Check nodes',
      modelFlag: 'openai/gpt-5',
      sqlitePath: '/tmp/a.db',
    });
  });

  it('returns empty object when no flags are provided', () => {
    expect(parsePiRunnerArgs([])).toBeDefined();
    expect(parsePiRunnerArgs([])).toEqual({});
  });

  it('exits 0 on --help and exits 1 on unknown flags', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      expect(() => parsePiRunnerArgs(['--help'])).toThrow('exit:0');
      expect(() => parsePiRunnerArgs(['--unknown-flag'])).toThrow('exit:1');
    } finally {
      exitSpy.mockRestore();
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('runPiAgentPrompt', () => {
  it('trims the prompt and invokes agent.prompt with options', async () => {
    const promptMock = vi.fn().mockResolvedValue({ text: 'Diagnosis complete' });
    const fakeAgent = {
      initialize: vi.fn(),
      openHarness: vi.fn(),
      prompt: promptMock,
    } as unknown as DefinedAgent;

    const out = await runPiAgentPrompt('  Why is my pod pending?  ', { model: 'anthropic/claude-sonnet-4-6' }, fakeAgent);
    expect(out).toBe('Diagnosis complete');
    expect(promptMock).toHaveBeenCalledWith('Why is my pod pending?', { model: 'anthropic/claude-sonnet-4-6' });
  });

  it('throws when the prompt is empty or whitespace-only', async () => {
    const fakeAgent = {
      initialize: vi.fn(),
      openHarness: vi.fn(),
      prompt: vi.fn(),
    } as unknown as DefinedAgent;

    await expect(runPiAgentPrompt('   ', {}, fakeAgent)).rejects.toThrow('Prompt must not be empty');
  });
});
