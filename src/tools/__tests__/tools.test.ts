import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the kubectl execution layer so the tool tests never spawn a real
// `kubectl` (which hangs without a cluster and makes tests flaky/slow). The
// read-only policy itself is exercised against the real runKubectl/validateCommand
// in kubectl.test.ts and kubectl-safety.test.ts.
const { runKubectl } = vi.hoisted(() => ({ runKubectl: vi.fn() }));
vi.mock('../../lib/kubectl.ts', () => ({
  runKubectl,
  NO_OUTPUT_MESSAGE: '(command produced no output)',
}));

import { kubectl, kubectlPlugin } from '../kubectl.ts';
import { listContexts, listNamespaces, makeListNamespaces, listContextsPlugin, listNamespacesPlugin } from '../kubeconfig.ts';
import type { CompiledRedactionRule } from '../../lib/regex-redact.ts';
import type { HeimdallConfig } from '../../lib/config.ts';

const KUBECONFIG = `
current-context: prod
contexts:
  - name: prod
    context:
      cluster: prod-cluster
      user: prod-user
  - name: staging
    context:
      cluster: staging-cluster
      user: staging-user
`;

beforeEach(() => {
  runKubectl.mockReset();
});

describe('kubectl tool', () => {
  it('has the expected model-facing name', () => {
    expect(kubectl.name).toBe('kubectl');
  });

  it('forwards args and context to runKubectl and returns its result', async () => {
    runKubectl.mockResolvedValue('pod/web   Running');
    const out = await kubectl.run({ input: { args: 'get pods', context: 'prod' } });
    expect(out).toBe('pod/web   Running');
    expect(runKubectl).toHaveBeenCalledWith('get pods', { context: 'prod' });
  });

  it('passes a blocked result straight through', async () => {
    runKubectl.mockResolvedValue('BLOCKED: Destructive command');
    expect(await kubectl.run({ input: { args: 'delete pod web' } })).toMatch(/^BLOCKED:/);
  });
});

describe('list_namespaces tool', () => {
  it('formats the namespace list returned by runKubectl', async () => {
    runKubectl.mockResolvedValue('default kube-system kube-public');
    const out = await listNamespaces.run({ input: { context: 'prod' } });
    expect(out).toMatch(/Namespaces \(3\)/);
    expect(out).toMatch(/kube-system/);
    expect(runKubectl).toHaveBeenCalledWith(
      'get namespaces -o jsonpath={.items[*].metadata.name}',
      { context: 'prod' },
    );
  });

  it('reports empty when the command produced no output (not fake namespaces)', async () => {
    runKubectl.mockResolvedValue('(command produced no output)');
    expect(await listNamespaces.run({ input: {} })).toMatch(/No namespaces found/);
  });

  it('surfaces a blocked/error result verbatim instead of parsing it', async () => {
    runKubectl.mockResolvedValue('kubectl exited with an error:\nconnection refused');
    expect(await listNamespaces.run({ input: {} })).toMatch(/kubectl exited/);
  });
});

describe('list_namespaces tool — namespace lockdown', () => {
  it('returns only the locked namespace without querying the cluster', async () => {
    const locked = makeListNamespaces('production');
    const out = await locked.run({ input: {} });
    expect(out).toBe('Namespaces (1):\n  production');
    expect(runKubectl).not.toHaveBeenCalled();
  });

  it('includes the lockdown note in the tool description', () => {
    const locked = makeListNamespaces('production');
    expect(locked.description).toContain('NAMESPACE LOCKDOWN ACTIVE');
    expect(locked.description).toContain("'production'");
  });

  it('has no lockdown note when no namespace is locked', () => {
    expect(listNamespaces.description).not.toContain('NAMESPACE LOCKDOWN ACTIVE');
  });
});

describe('list_contexts tool (real kubeconfig parsing)', () => {
  let dir: string;
  let cfg: string;
  let prevKubeconfig: string | undefined;
  let prevK8sServiceHost: string | undefined;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'heimdall-tools-'));
    cfg = join(dir, 'config');
    await writeFile(cfg, KUBECONFIG, 'utf8');
    prevKubeconfig = process.env.KUBECONFIG;
    process.env.KUBECONFIG = cfg;
    // Prevent in-cluster detection from short-circuiting these tests when they
    // run inside a Kubernetes pod.
    prevK8sServiceHost = process.env.KUBERNETES_SERVICE_HOST;
    delete process.env.KUBERNETES_SERVICE_HOST;
  });

  afterAll(async () => {
    if (prevKubeconfig === undefined) delete process.env.KUBECONFIG;
    else process.env.KUBECONFIG = prevKubeconfig;
    if (prevK8sServiceHost !== undefined) process.env.KUBERNETES_SERVICE_HOST = prevK8sServiceHost;
    await rm(dir, { recursive: true, force: true });
  });

  it('lists contexts and marks the current one', async () => {
    const out = await listContexts.run({ input: {} });
    expect(out).toMatch(/Contexts \(2\)/);
    expect(out).toMatch(/\* prod \(current\)/);
    expect(out).toMatch(/staging/);
  });

  it('reports when no contexts are found', async () => {
    process.env.KUBECONFIG = join(dir, 'missing');
    try {
      expect(await listContexts.run({ input: {} })).toMatch(/No kubeconfig contexts found/);
    } finally {
      process.env.KUBECONFIG = cfg;
    }
  });

  it('returns the in-cluster context when running inside a Kubernetes pod', async () => {
    process.env['KUBERNETES_SERVICE_HOST'] = '10.96.0.1';
    try {
      const out = await listContexts.run({ input: {} });
      expect(out).toBe('Contexts (1):\n* in-cluster (current)');
      expect(runKubectl).not.toHaveBeenCalled();
    } finally {
      delete process.env.KUBERNETES_SERVICE_HOST;
    }
  });
});

describe('listContextsPlugin', () => {
  it('key is "listContexts"', () => {
    expect(listContextsPlugin.key).toBe('listContexts');
  });

  it('factory returns a tool named list_contexts', () => {
    const config = {} as unknown as HeimdallConfig;
    const tool = listContextsPlugin.factory(config, []);
    expect(tool.name).toBe('list_contexts');
  });
});

describe('listNamespacesPlugin', () => {
  it('key is "listNamespaces"', () => {
    expect(listNamespacesPlugin.key).toBe('listNamespaces');
  });

  it('factory passes namespace.locked through to makeListNamespaces', () => {
    const config = { namespace: { locked: 'prod-ns' } } as unknown as HeimdallConfig;
    const tool = listNamespacesPlugin.factory(config, []);
    expect(tool.description).toContain('NAMESPACE LOCKDOWN ACTIVE');
    expect(tool.description).toContain("'prod-ns'");
  });

  it('factory works when namespace.locked is undefined', () => {
    const config = {} as unknown as HeimdallConfig;
    const tool = listNamespacesPlugin.factory(config, []);
    expect(tool.description).not.toContain('NAMESPACE LOCKDOWN');
  });
});

describe('kubectlPlugin', () => {
  it('key is "kubectl"', () => {
    expect(kubectlPlugin.key).toBe('kubectl');
  });

  it('factory passes audit, rules, and namespace.locked through to runKubectl', async () => {
    runKubectl.mockResolvedValue('ok');
    const auditConfig = { enabled: true, file: '/tmp/audit.log' };
    const rules: CompiledRedactionRule[] = [{ name: 'token', re: /bearer \S+/gi }];
    const config = {
      audit: auditConfig,
      redactSecrets: true,
      namespace: { locked: 'prod-ns' },
    } as unknown as HeimdallConfig;
    const tool = kubectlPlugin.factory(config, rules);
    expect(tool.description).toContain('NAMESPACE LOCKDOWN ACTIVE');
    await tool.run({ input: { args: 'get pods -n prod-ns' } });
    expect(runKubectl).toHaveBeenCalledWith(
      'get pods -n prod-ns',
      expect.objectContaining({
        audit: auditConfig,
        redactSecrets: true,
        regexRedactionRules: rules,
        lockedNamespace: 'prod-ns',
      }),
    );
  });
});
