import { describe, it, expect, afterEach } from 'vitest';
import { createPreToolUseHook } from '../safetyHooks.js';

async function runHook(command: string) {
  const hook = createPreToolUseHook();
  const input = {
    hook_event_name: 'PreToolUse' as const,
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'tool-1',
    session_id: 'session-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp',
    permission_mode: 'default',
  };

  return hook(input, undefined, { signal: new AbortController().signal });
}

describe('kubectl cache wrapper', () => {
  const envSnapshot = {
    cache: process.env.HEIMDALL_KUBECTL_CACHE,
    ttl: process.env.HEIMDALL_KUBECTL_CACHE_TTL,
    dir: process.env.HEIMDALL_KUBECTL_CACHE_DIR,
  };

  afterEach(() => {
    process.env.HEIMDALL_KUBECTL_CACHE = envSnapshot.cache;
    process.env.HEIMDALL_KUBECTL_CACHE_TTL = envSnapshot.ttl;
    process.env.HEIMDALL_KUBECTL_CACHE_DIR = envSnapshot.dir;
  });

  it('rewrites kubectl get -o json commands to use cache', async () => {
    const command = 'kubectl --context=prod get nodes -o json | jq ".items | length"';
    const result = await runHook(command);

    const updatedCommand = (result.updatedInput as { command?: string } | undefined)?.command;
    expect(updatedCommand).toBeTruthy();
    expect(updatedCommand).toContain('heimdall-kubectl-cache');
    expect(updatedCommand).toContain('kubectl --context=prod get nodes -o json');
    expect(updatedCommand).toContain('| jq ".items | length"');
  });

  it('does not rewrite non-json output commands', async () => {
    const command = 'kubectl --context=prod get nodes -o wide';
    const result = await runHook(command);

    expect(result.updatedInput).toBeUndefined();
  });

  it('does not rewrite when cache is disabled', async () => {
    process.env.HEIMDALL_KUBECTL_CACHE = '0';
    const command = 'kubectl --context=prod get nodes -o json | jq ".items | length"';
    const result = await runHook(command);

    expect(result.updatedInput).toBeUndefined();
  });
});
