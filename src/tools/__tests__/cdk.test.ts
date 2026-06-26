import { describe, it, expect, vi, beforeEach } from 'vitest';

const { runCdk } = vi.hoisted(() => ({ runCdk: vi.fn() }));
vi.mock('../../lib/cdk.ts', () => ({ runCdk }));

import { makeCdkQuery, cdkQuery, cdkPlugin } from '../cdk.ts';
import type { CompiledRedactionRule } from '../../lib/regex-redact.ts';
import type { HeimdallConfig } from '../../lib/config.ts';

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
    const result = await tool.run({ input: { args: 'ls' } });
    expect(result).toBe('MyStack\nOtherStack');
    expect(runCdk).toHaveBeenCalledWith('ls', expect.objectContaining({ regexRedactionRules: undefined }));
  });

  it('passes a blocked result straight through', async () => {
    runCdk.mockResolvedValue('BLOCKED: Destructive CDK command');
    const tool = makeCdkQuery();
    expect(await tool.run({ input: { args: 'deploy' } })).toMatch(/^BLOCKED:/);
  });

  it('passes options to runCdk', async () => {
    runCdk.mockResolvedValue('ok');
    const options = { cwd: '/my/app' };
    const tool = makeCdkQuery(options);
    await tool.run({ input: { args: 'diff' } });
    expect(runCdk).toHaveBeenCalledWith('diff', expect.objectContaining({ cwd: '/my/app' }));
  });

  it('forwards compiled regex redaction rules to runCdk', async () => {
    runCdk.mockResolvedValue('ok');
    const rules: CompiledRedactionRule[] = [{ name: 'secret', re: /AKIA[0-9A-Z]{16}/g }];
    const tool = makeCdkQuery(undefined, rules);
    await tool.run({ input: { args: 'ls' } });
    expect(runCdk).toHaveBeenCalledWith('ls', expect.objectContaining({ regexRedactionRules: rules }));
  });
});

describe('cdkPlugin', () => {
  it('key is "cdkQuery"', () => {
    expect(cdkPlugin.key).toBe('cdkQuery');
  });

  it('factory passes audit config and rules through to runCdk', async () => {
    runCdk.mockResolvedValue('ok');
    const auditConfig = { enabled: true, file: '/tmp/audit.log' };
    const rules: CompiledRedactionRule[] = [{ name: 'token', re: /bearer \S+/gi }];
    const tool = cdkPlugin.factory({ audit: auditConfig } as unknown as HeimdallConfig, rules);
    await tool.run({ input: { args: 'ls' } });
    expect(runCdk).toHaveBeenCalledWith('ls', expect.objectContaining({ audit: auditConfig, regexRedactionRules: rules }));
  });
});
