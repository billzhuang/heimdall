import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, rm, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    appendFile: vi.fn().mockImplementation(actual.appendFile),
    mkdir: vi.fn().mockImplementation(actual.mkdir),
  };
});
import {
  saveCheckpoint,
  loadCheckpoint,
  detectDrift,
  buildDriftPromptSection,
  parseNamespacesFromJson,
  parseWorkloadsFromJson,
  parseNodesFromJson,
  type ClusterCheckpoint,
  type DriftFinding,
} from '../drift.ts';

// ---------------------------------------------------------------------------
// saveCheckpoint / loadCheckpoint
// ---------------------------------------------------------------------------
describe('saveCheckpoint / loadCheckpoint', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = join(tmpdir(), `drift-test-${Date.now()}.jsonl`);
  });

  afterEach(async () => {
    await rm(tmpFile, { force: true });
  });

  it('returns null when file does not exist', async () => {
    const result = await loadCheckpoint(tmpFile + '.nonexistent');
    expect(result).toBeNull();
  });

  it('saves and loads back a single checkpoint', async () => {
    const cp: ClusterCheckpoint = {
      timestamp: '2026-01-01T00:00:00.000Z',
      namespaces: ['default', 'prod'],
      workloads: [{ kind: 'Deployment', namespace: 'prod', name: 'api' }],
      nodes: [{ name: 'node-1', status: 'Ready' }],
    };
    await saveCheckpoint(cp, tmpFile);
    const loaded = await loadCheckpoint(tmpFile);
    expect(loaded).toEqual(cp);
  });

  it('returns the LATEST entry when multiple checkpoints are appended', async () => {
    const first: ClusterCheckpoint = {
      timestamp: '2026-01-01T00:00:00.000Z',
      namespaces: ['default'],
      workloads: [],
      nodes: [],
    };
    const second: ClusterCheckpoint = {
      timestamp: '2026-01-02T00:00:00.000Z',
      namespaces: ['default', 'prod'],
      workloads: [{ kind: 'Deployment', namespace: 'prod', name: 'api' }],
      nodes: [{ name: 'node-1', status: 'Ready' }],
    };
    await saveCheckpoint(first, tmpFile);
    await saveCheckpoint(second, tmpFile);
    const loaded = await loadCheckpoint(tmpFile);
    expect(loaded?.timestamp).toBe('2026-01-02T00:00:00.000Z');
    expect(loaded?.namespaces).toContain('prod');
  });

  it('skips malformed JSONL lines without crashing', async () => {
    const valid: ClusterCheckpoint = {
      timestamp: '2026-01-01T00:00:00.000Z',
      namespaces: ['default'],
      workloads: [],
      nodes: [],
    };
    await writeFile(tmpFile, `not-valid-json\n${JSON.stringify(valid)}\n{broken\n`, 'utf8');
    const loaded = await loadCheckpoint(tmpFile);
    expect(loaded?.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns null for a file containing only malformed lines', async () => {
    await writeFile(tmpFile, 'not-valid\nalso-not-valid\n', 'utf8');
    const loaded = await loadCheckpoint(tmpFile);
    expect(loaded).toBeNull();
  });

  it('rethrows non-ENOENT errors', async () => {
    await expect(loadCheckpoint('/dev/null/impossible')).rejects.toThrow();
  });

  it('creates parent directory when it does not exist', async () => {
    const newDir = join(tmpdir(), `drift-newdir-${Date.now()}`);
    const filePath = join(newDir, 'sub', 'checkpoints.jsonl');
    try {
      const cp: ClusterCheckpoint = {
        timestamp: '2026-01-01T00:00:00.000Z',
        namespaces: ['default'],
        workloads: [],
        nodes: [],
      };
      await saveCheckpoint(cp, filePath);
      const loaded = await loadCheckpoint(filePath);
      expect(loaded?.timestamp).toBe('2026-01-01T00:00:00.000Z');
    } finally {
      await rm(newDir, { recursive: true, force: true });
    }
  });

  it('re-throws non-ENOENT errors from appendFile', async () => {
    vi.mocked(appendFile).mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    );
    const cp: ClusterCheckpoint = {
      timestamp: '2026-01-01T00:00:00.000Z',
      namespaces: [],
      workloads: [],
      nodes: [],
    };
    try {
      await expect(saveCheckpoint(cp, tmpFile)).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      vi.mocked(appendFile).mockClear();
    }
  });

  it('does not call mkdir when appendFile succeeds (try-first strategy)', async () => {
    const cp: ClusterCheckpoint = {
      timestamp: '2026-01-01T00:00:00.000Z',
      namespaces: ['default'],
      workloads: [],
      nodes: [],
    };
    vi.mocked(mkdir).mockClear();
    vi.mocked(appendFile).mockClear();
    await saveCheckpoint(cp, tmpFile);
    expect(vi.mocked(mkdir)).not.toHaveBeenCalled();
    expect(vi.mocked(appendFile)).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// detectDrift
// ---------------------------------------------------------------------------
describe('detectDrift', () => {
  const base: ClusterCheckpoint = {
    timestamp: '2026-01-01T00:00:00.000Z',
    namespaces: ['default', 'prod'],
    workloads: [
      { kind: 'Deployment', namespace: 'prod', name: 'api' },
      { kind: 'StatefulSet', namespace: 'prod', name: 'db' },
    ],
    nodes: [{ name: 'node-1', status: 'Ready' }, { name: 'node-2', status: 'Ready' }],
  };

  it('returns empty array when previous is null', () => {
    const current: ClusterCheckpoint = { ...base, timestamp: '2026-01-02T00:00:00.000Z' };
    expect(detectDrift(current, null)).toEqual([]);
  });

  it('returns empty array when current equals previous', () => {
    const current: ClusterCheckpoint = { ...base, timestamp: '2026-01-02T00:00:00.000Z' };
    expect(detectDrift(current, base)).toEqual([]);
  });

  it('detects new namespace', () => {
    const current: ClusterCheckpoint = {
      ...base,
      timestamp: '2026-01-02T00:00:00.000Z',
      namespaces: ['default', 'prod', 'staging'],
    };
    const findings = detectDrift(current, base);
    expect(findings.some((f) => f.type === 'new_namespace' && f.resource === 'Namespace/staging')).toBe(true);
  });

  it('detects deleted namespace', () => {
    const current: ClusterCheckpoint = {
      ...base,
      timestamp: '2026-01-02T00:00:00.000Z',
      namespaces: ['default'],
    };
    const findings = detectDrift(current, base);
    expect(findings.some((f) => f.type === 'deleted_namespace' && f.resource === 'Namespace/prod')).toBe(true);
  });

  it('detects new workload', () => {
    const current: ClusterCheckpoint = {
      ...base,
      timestamp: '2026-01-02T00:00:00.000Z',
      workloads: [
        ...base.workloads,
        { kind: 'Deployment', namespace: 'prod', name: 'worker' },
      ],
    };
    const findings = detectDrift(current, base);
    expect(findings.some((f) => f.type === 'new_workload' && f.resource.includes('worker'))).toBe(true);
  });

  it('detects deleted workload', () => {
    const current: ClusterCheckpoint = {
      ...base,
      timestamp: '2026-01-02T00:00:00.000Z',
      workloads: [{ kind: 'Deployment', namespace: 'prod', name: 'api' }],
    };
    const findings = detectDrift(current, base);
    expect(findings.some((f) => f.type === 'deleted_workload' && f.resource.includes('db'))).toBe(true);
  });

  it('detects new node (topology change)', () => {
    const current: ClusterCheckpoint = {
      ...base,
      timestamp: '2026-01-02T00:00:00.000Z',
      nodes: [...base.nodes, { name: 'node-3', status: 'Ready' }],
    };
    const findings = detectDrift(current, base);
    expect(findings.some((f) => f.type === 'topology_change' && f.resource === 'Node/node-3')).toBe(true);
  });

  it('detects removed node (topology change)', () => {
    const current: ClusterCheckpoint = {
      ...base,
      timestamp: '2026-01-02T00:00:00.000Z',
      nodes: [{ name: 'node-1', status: 'Ready' }],
    };
    const findings = detectDrift(current, base);
    expect(findings.some((f) => f.type === 'topology_change' && f.resource === 'Node/node-2')).toBe(true);
  });

  it('detects multiple drift types in one call', () => {
    const current: ClusterCheckpoint = {
      timestamp: '2026-01-02T00:00:00.000Z',
      namespaces: ['default', 'staging'],     // prod removed, staging added
      workloads: [
        { kind: 'Deployment', namespace: 'default', name: 'new-svc' }, // new
        // api and db gone
      ],
      nodes: [{ name: 'node-1', status: 'Ready' }], // node-2 gone
    };
    const findings = detectDrift(current, base);
    const types = findings.map((f) => f.type);
    expect(types).toContain('new_namespace');
    expect(types).toContain('deleted_namespace');
    expect(types).toContain('new_workload');
    expect(types).toContain('deleted_workload');
    expect(types).toContain('topology_change');
  });

  it('treats different kinds with the same namespace/name as distinct workloads', () => {
    const current: ClusterCheckpoint = {
      ...base,
      timestamp: '2026-01-02T00:00:00.000Z',
      workloads: [
        { kind: 'Deployment', namespace: 'prod', name: 'api' },
        { kind: 'StatefulSet', namespace: 'prod', name: 'db' },
        { kind: 'DaemonSet', namespace: 'prod', name: 'api' }, // same name, different kind
      ],
    };
    const findings = detectDrift(current, base);
    expect(findings.some((f) => f.type === 'new_workload' && f.resource.startsWith('DaemonSet'))).toBe(true);
  });

  it('treats a workload moving namespace as a deleted + new workload', () => {
    const current: ClusterCheckpoint = {
      ...base,
      timestamp: '2026-01-02T00:00:00.000Z',
      workloads: [
        // api moved from prod → staging; db unchanged
        { kind: 'Deployment', namespace: 'staging', name: 'api' },
        { kind: 'StatefulSet', namespace: 'prod', name: 'db' },
      ],
    };
    const findings = detectDrift(current, base);
    const types = findings.map((f) => f.type);
    expect(types).toContain('deleted_workload');
    expect(types).toContain('new_workload');
    expect(findings.some((f) => f.type === 'deleted_workload' && f.resource.includes('prod'))).toBe(true);
    expect(findings.some((f) => f.type === 'new_workload' && f.resource.includes('staging'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildDriftPromptSection
// ---------------------------------------------------------------------------
describe('buildDriftPromptSection', () => {
  it('returns empty string when findings array is empty', () => {
    expect(buildDriftPromptSection([], '2026-01-01T00:00:00.000Z')).toBe('');
  });

  it('includes the previous timestamp in the header', () => {
    const findings: DriftFinding[] = [
      { type: 'new_namespace', resource: 'Namespace/staging', message: 'staging appeared.' },
    ];
    const out = buildDriftPromptSection(findings, '2026-01-01T00:00:00.000Z');
    expect(out).toContain('2026-01-01T00:00:00.000Z');
  });

  it('lists all findings with type labels', () => {
    const findings: DriftFinding[] = [
      { type: 'new_namespace', resource: 'Namespace/staging', message: 'staging appeared.' },
      { type: 'deleted_workload', resource: 'Deployment/api in prod', message: 'api gone.' },
    ];
    const out = buildDriftPromptSection(findings, '2026-01-01T00:00:00.000Z');
    expect(out).toContain('new_namespace');
    expect(out).toContain('deleted_workload');
    expect(out).toContain('Namespace/staging');
    expect(out).toContain('Deployment/api in prod');
  });

  it('separates the drift section from the main prompt with a horizontal rule', () => {
    const findings: DriftFinding[] = [
      { type: 'topology_change', resource: 'Node/node-3', message: 'node-3 joined.' },
    ];
    const out = buildDriftPromptSection(findings, '2026-01-01T00:00:00.000Z');
    expect(out).toContain('---');
  });

  it('numbers the findings starting from 1', () => {
    const findings: DriftFinding[] = [
      { type: 'new_workload', resource: 'Deployment/api in prod', message: 'api appeared.' },
      { type: 'new_workload', resource: 'StatefulSet/db in prod', message: 'db appeared.' },
    ];
    const out = buildDriftPromptSection(findings, '2026-01-01T00:00:00.000Z');
    expect(out).toContain('1.');
    expect(out).toContain('2.');
  });
});

// ---------------------------------------------------------------------------
// parseNamespacesFromJson
// ---------------------------------------------------------------------------
describe('parseNamespacesFromJson', () => {
  it('extracts namespace names from kubectl JSON', () => {
    const raw = JSON.stringify({
      items: [
        { metadata: { name: 'default' } },
        { metadata: { name: 'prod' } },
        { metadata: { name: 'kube-system' } },
      ],
    });
    expect(parseNamespacesFromJson(raw)).toEqual(['default', 'prod', 'kube-system']);
  });

  it('returns empty array on parse error', () => {
    expect(parseNamespacesFromJson('not-json')).toEqual([]);
  });

  it('returns empty array for empty items', () => {
    expect(parseNamespacesFromJson(JSON.stringify({ items: [] }))).toEqual([]);
  });

  it('returns empty array when items field is absent', () => {
    expect(parseNamespacesFromJson(JSON.stringify({}))).toEqual([]);
  });

  it('skips items with no metadata name', () => {
    const raw = JSON.stringify({ items: [{ metadata: {} }, { metadata: { name: 'prod' } }] });
    expect(parseNamespacesFromJson(raw)).toEqual(['prod']);
  });
});

// ---------------------------------------------------------------------------
// parseWorkloadsFromJson
// ---------------------------------------------------------------------------
describe('parseWorkloadsFromJson', () => {
  it('extracts Deployment, StatefulSet, and DaemonSet entries', () => {
    const raw = JSON.stringify({
      items: [
        { kind: 'Deployment', metadata: { name: 'api', namespace: 'prod' } },
        { kind: 'StatefulSet', metadata: { name: 'db', namespace: 'prod' } },
        { kind: 'DaemonSet', metadata: { name: 'agent', namespace: 'kube-system' } },
        { kind: 'Pod', metadata: { name: 'ignore-me', namespace: 'prod' } },
      ],
    });
    const result = parseWorkloadsFromJson(raw);
    expect(result).toHaveLength(3);
    expect(result.map((w) => w.kind)).toEqual(['Deployment', 'StatefulSet', 'DaemonSet']);
  });

  it('returns empty array on parse error', () => {
    expect(parseWorkloadsFromJson('not-json')).toEqual([]);
  });

  it('returns empty array when items field is absent', () => {
    expect(parseWorkloadsFromJson(JSON.stringify({}))).toEqual([]);
  });

  it('skips items missing name or namespace', () => {
    const raw = JSON.stringify({
      items: [
        { kind: 'Deployment', metadata: { name: 'api' } },   // no namespace
        { kind: 'Deployment', metadata: { namespace: 'prod' } }, // no name
        { kind: 'Deployment', metadata: { name: 'ok', namespace: 'prod' } },
      ],
    });
    const result = parseWorkloadsFromJson(raw);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// parseNodesFromJson
// ---------------------------------------------------------------------------
describe('parseNodesFromJson', () => {
  it('marks nodes with Ready=True as Ready', () => {
    const raw = JSON.stringify({
      items: [
        {
          metadata: { name: 'node-1' },
          status: { conditions: [{ type: 'Ready', status: 'True' }] },
        },
      ],
    });
    const result = parseNodesFromJson(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ name: 'node-1', status: 'Ready' });
  });

  it('marks nodes with Ready=False as NotReady', () => {
    const raw = JSON.stringify({
      items: [
        {
          metadata: { name: 'node-2' },
          status: { conditions: [{ type: 'Ready', status: 'False' }] },
        },
      ],
    });
    const result = parseNodesFromJson(raw);
    expect(result[0]).toEqual({ name: 'node-2', status: 'NotReady' });
  });

  it('marks nodes with no Ready condition as NotReady', () => {
    const raw = JSON.stringify({
      items: [
        {
          metadata: { name: 'node-3' },
          status: { conditions: [] },
        },
      ],
    });
    const result = parseNodesFromJson(raw);
    expect(result[0]).toEqual({ name: 'node-3', status: 'NotReady' });
  });

  it('returns empty array on parse error', () => {
    expect(parseNodesFromJson('not-json')).toEqual([]);
  });

  it('returns empty array when items field is absent', () => {
    expect(parseNodesFromJson(JSON.stringify({}))).toEqual([]);
  });

  it('skips items missing a name', () => {
    const raw = JSON.stringify({
      items: [
        { metadata: {}, status: { conditions: [] } },
        { metadata: { name: 'node-ok' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
      ],
    });
    const result = parseNodesFromJson(raw);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('node-ok');
  });
});
