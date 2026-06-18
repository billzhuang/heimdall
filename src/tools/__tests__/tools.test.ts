import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('kubectl tool', () => {
  it('has the expected model-facing name and schema-validated execute', () => {
    expect(kubectl.name).toBe('kubectl');
    expect(typeof kubectl.execute).toBe('function');
  });

  it('blocks destructive args through the tool boundary', async () => {
    expect(await kubectl.execute({ args: 'delete pod web -n prod' })).toMatch(/^BLOCKED:/);
  });

  it('passes read-only args through the policy gate', async () => {
    // Execution fails without a cluster, but the policy must not block it.
    expect(await kubectl.execute({ args: 'get pods' })).not.toMatch(/^BLOCKED:/);
  });
});

describe('list_contexts / list_namespaces tools', () => {
  let dir: string;
  let cfg: string;
  let prevKubeconfig: string | undefined;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'heimdall-tools-'));
    cfg = join(dir, 'config');
    await writeFile(cfg, KUBECONFIG, 'utf8');
    prevKubeconfig = process.env.KUBECONFIG;
    process.env.KUBECONFIG = cfg;
  });

  afterAll(async () => {
    if (prevKubeconfig === undefined) delete process.env.KUBECONFIG;
    else process.env.KUBECONFIG = prevKubeconfig;
    await rm(dir, { recursive: true, force: true });
  });

  it('lists contexts and marks the current one', async () => {
    const out = await listContexts.execute({});
    expect(out).toMatch(/Contexts \(2\)/);
    expect(out).toMatch(/\* prod \(current\)/);
    expect(out).toMatch(/staging/);
  });

  it('reports when no contexts are found', async () => {
    const out = await listContexts.execute({});
    process.env.KUBECONFIG = join(dir, 'missing');
    try {
      expect(await listContexts.execute({})).toMatch(/No kubeconfig contexts found/);
    } finally {
      process.env.KUBECONFIG = cfg;
    }
    expect(out).toMatch(/Contexts/); // sanity: the first call still worked
  });

  it('list_namespaces returns a string without throwing (no cluster in CI)', async () => {
    const out = await listNamespaces.execute({});
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});
