import { describe, it, expect, vi } from 'vitest';
import { invokeAgentForFinding } from '../agent-invoke.ts';

describe('invokeAgentForFinding', () => {
  it('returns the parsed finding and trimmed text on success', async () => {
    const agentFn = vi.fn().mockResolvedValueOnce('  {"answer":"ok","severity":"info"}  ');
    const result = await invokeAgentForFinding(agentFn, 'why?', 'anthropic/claude-sonnet-4-6');
    expect(result).toEqual({
      ok: true,
      finding: { answer: 'ok', severity: 'info' },
      trimmed: '{"answer":"ok","severity":"info"}',
    });
    expect(agentFn).toHaveBeenCalledWith('why?', 'anthropic/claude-sonnet-4-6');
  });

  it('returns a 500 result when the agent produces only whitespace', async () => {
    const agentFn = vi.fn().mockResolvedValueOnce('   \n  ');
    const result = await invokeAgentForFinding(agentFn, 'why?', 'anthropic/claude-sonnet-4-6');
    expect(result).toEqual({ ok: false, status: 500, error: 'Agent produced no output' });
  });

  it('returns a 500 result with the error message when the agent throws', async () => {
    const agentFn = vi.fn().mockRejectedValueOnce(new Error('timed out'));
    const result = await invokeAgentForFinding(agentFn, 'why?', 'anthropic/claude-sonnet-4-6');
    expect(result).toEqual({ ok: false, status: 500, error: 'Agent error: timed out' });
  });

  it('returns a 500 result when the agent output is not valid JSON', async () => {
    const agentFn = vi.fn().mockResolvedValueOnce('not-json');
    const result = await invokeAgentForFinding(agentFn, 'why?', 'anthropic/claude-sonnet-4-6');
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 500 });
  });

  it('falls back to a null finding when the agent output parses to a non-object value', async () => {
    for (const raw of ['"just a string"', '42', 'true', '[1,2,3]']) {
      const agentFn = vi.fn().mockResolvedValueOnce(raw);
      const result = await invokeAgentForFinding(agentFn, 'why?', 'anthropic/claude-sonnet-4-6');
      expect(result).toEqual({ ok: true, finding: null, trimmed: raw });
    }
  });
});
