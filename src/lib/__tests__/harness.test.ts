import { describe, it, expect, vi } from 'vitest';
import { BLOCKED_PREFIX, withSafetyCheck, createCheck, type SafetyCheck } from '../harness.ts';

describe('BLOCKED_PREFIX', () => {
  it('is the canonical blocked response prefix', () => {
    expect(BLOCKED_PREFIX).toBe('BLOCKED: ');
  });
});

describe('withSafetyCheck', () => {
  const allowAll: SafetyCheck = () => ({ allowed: true, reason: 'ok' });
  const blockAll: SafetyCheck = () => ({ allowed: false, reason: 'always blocked' });

  const executor = async (input: Record<string, unknown>) =>
    `executed: ${JSON.stringify(input)}`;

  it('calls executor when all checks pass', async () => {
    const safe = withSafetyCheck(executor, allowAll);
    expect(await safe({ cmd: 'get pods' })).toBe('executed: {"cmd":"get pods"}');
  });

  it('returns BLOCKED response when a check fails', async () => {
    const safe = withSafetyCheck(executor, blockAll);
    const result = await safe({ cmd: 'delete pods --all' });
    expect(result).toBe(`${BLOCKED_PREFIX}always blocked`);
  });

  it('blocked response starts with BLOCKED_PREFIX', async () => {
    const safe = withSafetyCheck(executor, blockAll);
    expect((await safe({})).startsWith(BLOCKED_PREFIX)).toBe(true);
  });

  it('runs checks in order and stops at first failure', async () => {
    const visited: number[] = [];
    const check1: SafetyCheck = () => { visited.push(1); return { allowed: true, reason: '1' }; };
    const check2: SafetyCheck = () => { visited.push(2); return { allowed: false, reason: 'blocked by 2' }; };
    const check3: SafetyCheck = () => { visited.push(3); return { allowed: true, reason: '3' }; };

    const safe = withSafetyCheck(executor, check1, check2, check3);
    const result = await safe({});

    expect(result).toBe(`${BLOCKED_PREFIX}blocked by 2`);
    expect(visited).toEqual([1, 2]); // check3 must never run
  });

  it('passes with zero checks (unrestricted executor)', async () => {
    const safe = withSafetyCheck(executor);
    expect(await safe({ x: 1 })).toContain('executed');
  });

  it('forwards the exact input object to the executor', async () => {
    const captured: Record<string, unknown>[] = [];
    const spy = async (input: Record<string, unknown>) => {
      captured.push(input);
      return 'ok';
    };
    const safe = withSafetyCheck(spy, allowAll);
    await safe({ a: 1, b: 'two' });
    expect(captured[0]).toEqual({ a: 1, b: 'two' });
  });

  it('does not call executor when a check blocks', async () => {
    const executorSpy = vi.fn(async () => 'should not run');
    const safe = withSafetyCheck(executorSpy, blockAll);
    await safe({});
    expect(executorSpy).not.toHaveBeenCalled();
  });
});

describe('createCheck', () => {
  it('allows when predicate returns null', () => {
    const check = createCheck(() => null);
    const result = check({});
    expect(result.allowed).toBe(true);
  });

  it('blocks when predicate returns a non-null string', () => {
    const check = createCheck(() => 'operation not permitted');
    const result = check({});
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('operation not permitted');
  });

  it('passes input to the predicate', () => {
    const check = createCheck<{ action: string }>(({ action }) =>
      action === 'write' ? 'write is not allowed' : null,
    );
    expect(check({ action: 'read' }).allowed).toBe(true);
    expect(check({ action: 'write' }).allowed).toBe(false);
    expect(check({ action: 'write' }).reason).toBe('write is not allowed');
  });

  it('result can be composed with withSafetyCheck', async () => {
    const executor = async () => 'ran';
    const check = createCheck<{ action: string }>(({ action }) =>
      action === 'delete' ? 'delete is not allowed' : null,
    );
    const safe = withSafetyCheck(executor, check);
    expect(await safe({ action: 'get' })).toBe('ran');
    expect(await safe({ action: 'delete' })).toBe(`${BLOCKED_PREFIX}delete is not allowed`);
  });
});
