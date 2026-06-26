import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

afterEach(() => {
  vi.unstubAllEnvs();
});
import {
  getContextNames,
  getDefaultKubeconfigPath,
  isInCluster,
  mergeKubeconfigs,
  parseKubeconfig,
  parseKubeconfigContent,
  resolveKubeconfigPath,
} from '../kubeconfig.ts';

const SAMPLE = `
apiVersion: v1
kind: Config
current-context: prod
contexts:
  - name: prod
    context:
      cluster: prod-cluster
      user: prod-user
      namespace: payments
  - name: staging
    context:
      cluster: staging-cluster
      user: staging-user
`;

describe('parseKubeconfigContent', () => {
  it('parses contexts and current-context', () => {
    const parsed = parseKubeconfigContent(SAMPLE);
    expect(parsed).not.toBeNull();
    expect(parsed!.currentContext).toBe('prod');
    expect(parsed!.contexts).toHaveLength(2);
    expect(parsed!.contexts[0]).toEqual({
      name: 'prod',
      cluster: 'prod-cluster',
      user: 'prod-user',
      namespace: 'payments',
    });
  });

  it('returns null for invalid or empty config', () => {
    expect(parseKubeconfigContent('not: [valid')).toBeNull();
    expect(parseKubeconfigContent('apiVersion: v1')).toBeNull();
    expect(parseKubeconfigContent('')).toBeNull();
    expect(parseKubeconfigContent('contexts: []')).toBeNull();
  });

  it('tolerates a context without a namespace and a missing current-context', () => {
    const parsed = parseKubeconfigContent(`
contexts:
  - name: dev
    context:
      cluster: dev
      user: dev
`);
    expect(parsed!.currentContext).toBeNull();
    expect(parsed!.contexts[0].namespace).toBeUndefined();
  });
});

describe('path helpers', () => {
  it('getDefaultKubeconfigPath points at ~/.kube/config', () => {
    expect(getDefaultKubeconfigPath().replace(/\\/g, '/')).toMatch(/\.kube\/config$/);
  });

  it('resolveKubeconfigPath uses KUBECONFIG env var when set', () => {
    vi.stubEnv('KUBECONFIG', '/env/kubeconfig');
    expect(resolveKubeconfigPath()).toBe('/env/kubeconfig');
  });

  it('resolveKubeconfigPath uses an explicit path over the env var', () => {
    vi.stubEnv('KUBECONFIG', '/env/kubeconfig');
    expect(resolveKubeconfigPath('/explicit')).toBe('/explicit');
  });

  it('resolveKubeconfigPath falls back to the default when KUBECONFIG is unset', () => {
    vi.stubEnv('KUBECONFIG', undefined as unknown as string);
    expect(resolveKubeconfigPath()).toBe(getDefaultKubeconfigPath());
  });
});

describe('parseKubeconfig (async, real files)', () => {
  let dir: string;
  let fileA: string;
  let fileB: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'heimdall-kcfg-'));
    fileA = join(dir, 'a.yaml');
    fileB = join(dir, 'b.yaml');
    await writeFile(fileA, SAMPLE, 'utf8');
    await writeFile(
      fileB,
      `
current-context: dev
contexts:
  - name: dev
    context:
      cluster: dev
      user: dev
`,
      'utf8',
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a single file', async () => {
    const parsed = await parseKubeconfig(fileA);
    expect(parsed!.currentContext).toBe('prod');
    expect(getContextNames(parsed!)).toEqual(['prod', 'staging']);
  });

  it('merges multiple files joined by the platform separator (first current-context wins)', async () => {
    const sep = process.platform === 'win32' ? ';' : ':';
    const parsed = await parseKubeconfig(`${fileA}${sep}${fileB}`);
    expect(getContextNames(parsed!)).toEqual(['prod', 'staging', 'dev']);
    expect(parsed!.currentContext).toBe('prod');
  });

  it('skips unreadable files and returns null when none are readable', async () => {
    const sep = process.platform === 'win32' ? ';' : ':';
    const missing = join(dir, 'does-not-exist.yaml');
    const partial = await parseKubeconfig(`${missing}${sep}${fileB}`);
    expect(getContextNames(partial!)).toEqual(['dev']);
    expect(await parseKubeconfig(missing)).toBeNull();
  });

  it('splits on ";" when platform is win32', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32' as NodeJS.Platform);
    try {
      const parsed = await parseKubeconfig(`${fileA};${fileB}`);
      expect(getContextNames(parsed!)).toEqual(['prod', 'staging', 'dev']);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('getContextNames', () => {
  it('extracts context names', () => {
    const parsed = parseKubeconfigContent(SAMPLE)!;
    expect(getContextNames(parsed)).toEqual(['prod', 'staging']);
  });
});

describe('mergeKubeconfigs', () => {
  it('merges contexts and keeps the first current-context', () => {
    const a = parseKubeconfigContent(SAMPLE)!;
    const b = parseKubeconfigContent(`
contexts:
  - name: dev
    context:
      cluster: dev
      user: dev
`)!;
    const merged = mergeKubeconfigs([a, b, null]);
    expect(merged!.contexts).toHaveLength(3);
    expect(merged!.currentContext).toBe('prod');
  });

  it('returns null when nothing merges', () => {
    expect(mergeKubeconfigs([null, null])).toBeNull();
  });

  it('deduplicates context names across files (first wins)', () => {
    const a = parseKubeconfigContent(SAMPLE)!; // has `prod`, `staging`
    const b = parseKubeconfigContent(`
contexts:
  - name: prod
    context:
      cluster: other
      user: other
`)!;
    const merged = mergeKubeconfigs([a, b]);
    expect(merged!.contexts).toHaveLength(2);
    expect(getContextNames(merged!)).toEqual(['prod', 'staging']);
    expect(merged!.contexts.find((c) => c.name === 'prod')!.cluster).toBe('prod-cluster');
  });
});

describe('resolveKubeconfigPath', () => {
  it('prefers an explicit path over the environment', () => {
    expect(resolveKubeconfigPath('/custom/config')).toBe('/custom/config');
  });
});

describe('isInCluster', () => {
  it('returns true when KUBERNETES_SERVICE_HOST is set', () => {
    vi.stubEnv('KUBERNETES_SERVICE_HOST', '10.0.0.1');
    expect(isInCluster()).toBe(true);
  });

  it('returns false when KUBERNETES_SERVICE_HOST is absent', () => {
    vi.stubEnv('KUBERNETES_SERVICE_HOST', undefined as unknown as string);
    expect(isInCluster()).toBe(false);
  });
});

