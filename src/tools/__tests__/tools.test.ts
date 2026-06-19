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

import { kubectl } from '../kubectl.ts';
import { listContexts, listNamespaces } from '../kubeconfig.ts';

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
    const out = await kubectl.execute({ args: 'get pods', context: 'prod' });
    expect(out).toBe('pod/web   Running');
    expect(runKubectl).toHaveBeenCalledWith('get pods', { context: 'prod' });
  });

  it('passes a blocked result straight through', async () => {
    runKubectl.mockResolvedValue('BLOCKED: Destructive command');
    expect(await kubectl.execute({ args: 'delete pod web' })).toMatch(/^BLOCKED:/);
  });
});

describe('list_namespaces tool', () => {
  it('formats the namespace list returned by runKubectl', async () => {
    runKubectl.mockResolvedValue('default kube-system kube-public');
    const out = await listNamespaces.execute({ context: 'prod' });
    expect(out).toMatch(/Namespaces \(3\)/);
    expect(out).toMatch(/kube-system/);
    expect(runKubectl).toHaveBeenCalledWith(
      'get namespaces -o jsonpath={.items[*].metadata.name}',
      { context: 'prod' },
    );
  });

  it('reports empty when the command produced no output (not fake namespaces)', async () => {
    runKubectl.mockResolvedValue('(command produced no output)');
    expect(await listNamespaces.execute({})).toMatch(/No namespaces found/);
  });

  it('surfaces a blocked/error result verbatim instead of parsing it', async () => {
    runKubectl.mockResolvedValue('kubectl exited with an error:\nconnection refused');
    expect(await listNamespaces.execute({})).toMatch(/kubectl exited/);
  });
});

describe('list_contexts tool (real kubeconfig parsing)', () => {
  let dir: string;
  let cfg: string;
  let prevKubeconfig: string | undefined;
  let prevK8sServiceHost: string | undefined;
  let prevEksCluster: string | undefined;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'heimdall-tools-'));
    cfg = join(dir, 'config');
    await writeFile(cfg, KUBECONFIG, 'utf8');
    prevKubeconfig = process.env.KUBECONFIG;
    process.env.KUBECONFIG = cfg;
    // Prevent in-cluster detection from short-circuiting these tests when they
    // run inside a Kubernetes pod (e.g. in CI deployed to EKS).
    prevK8sServiceHost = process.env.KUBERNETES_SERVICE_HOST;
    delete process.env.KUBERNETES_SERVICE_HOST;
    // Prevent EKS mode from overriding the local KUBECONFIG fixture.
    prevEksCluster = process.env.HEIMDALL_EKS_CLUSTER;
    delete process.env.HEIMDALL_EKS_CLUSTER;
  });

  afterAll(async () => {
    if (prevKubeconfig === undefined) delete process.env.KUBECONFIG;
    else process.env.KUBECONFIG = prevKubeconfig;
    if (prevK8sServiceHost !== undefined) process.env.KUBERNETES_SERVICE_HOST = prevK8sServiceHost;
    if (prevEksCluster !== undefined) process.env.HEIMDALL_EKS_CLUSTER = prevEksCluster;
    await rm(dir, { recursive: true, force: true });
  });

  it('lists contexts and marks the current one', async () => {
    const out = await listContexts.execute({});
    expect(out).toMatch(/Contexts \(2\)/);
    expect(out).toMatch(/\* prod \(current\)/);
    expect(out).toMatch(/staging/);
  });

  it('reports when no contexts are found', async () => {
    process.env.KUBECONFIG = join(dir, 'missing');
    try {
      expect(await listContexts.execute({})).toMatch(/No kubeconfig contexts found/);
    } finally {
      process.env.KUBECONFIG = cfg;
    }
  });
});
