import { describe, it, expect, vi, beforeEach } from 'vitest';

const { runCdk } = vi.hoisted(() => ({ runCdk: vi.fn() }));
vi.mock('../../lib/cdk.ts', () => ({
  runCdk,
  NO_OUTPUT_MESSAGE: '(command produced no output)',
}));

import { makeCdkQuery, cdkQuery } from '../cdk.ts';

beforeEach(() => {
  runCdk.mockReset();
});

describe('makeCdkQuery — tool metadata', () => {
  it('has the expected model-facing name', () => {
    expect(makeCdkQuery().name).toBe('cdk_query');
  });

  it('exported cdkQuery singleton has name cdk_query', () => {
    expect(cdkQuery.name).toBe('cdk_query');
  });
});

describe('makeCdkQuery — execute', () => {
  it('forwards args to runCdk and returns its result', async () => {
    runCdk.mockResolvedValue('MyStack\nOtherStack');
    const tool = makeCdkQuery();
    const result = await tool.execute({ args: 'ls' });
    expect(result).toBe('MyStack\nOtherStack');
    expect(runCdk).toHaveBeenCalledWith('ls', expect.objectContaining({}));
  });

  it('passes a blocked result straight through', async () => {
    runCdk.mockResolvedValue('BLOCKED: Destructive CDK command');
    const tool = makeCdkQuery();
    expect(await tool.execute({ args: 'deploy' })).toMatch(/^BLOCKED:/);
  });

  it('passes options to runCdk', async () => {
    runCdk.mockResolvedValue('ok');
    const options = { cwd: '/my/app' };
    const tool = makeCdkQuery(options);
    await tool.execute({ args: 'diff' });
    expect(runCdk).toHaveBeenCalledWith('diff', expect.objectContaining({ cwd: '/my/app' }));
  });
});
