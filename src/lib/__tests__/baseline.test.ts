import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn().mockImplementation(actual.writeFile) };
});
import {
  buildBaselineKey,
  readBaselines,
  upsertBaseline,
  queryTopBaselines,
  buildBaselineContext,
  formatBaselineDate,
  formatBaselineEntry,
  parseTriageFindings,
  scanFindingFields,
  inferDiagnosisSeverity,
  truncateSummary,
  resolveBaselineFilePath,
  type BaselineEntry,
} from '../baseline.ts';

// ---------------------------------------------------------------------------
// buildBaselineKey
// ---------------------------------------------------------------------------
describe('buildBaselineKey', () => {
  it('concatenates parts with / separator', () => {
    expect(buildBaselineKey('prod', 'default', 'Pod', 'api-7f9d')).toBe('prod/default/Pod/api-7f9d');
  });

  it('handles empty strings', () => {
    expect(buildBaselineKey('', '', '', '')).toBe('///');
  });
});

// ---------------------------------------------------------------------------
// readBaselines / upsertBaseline
// ---------------------------------------------------------------------------
describe('readBaselines', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = join(tmpdir(), `baseline-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  });

  afterEach(async () => {
    await rm(tmpFile, { force: true });
  });

  it('returns empty array when file does not exist', async () => {
    expect(await readBaselines(tmpFile + '.nonexistent')).toEqual([]);
  });

  it('skips malformed lines without crashing', async () => {
    const good: BaselineEntry = {
      key: 'c/ns/Pod/p',
      cluster: 'c',
      namespace: 'ns',
      kind: 'Pod',
      name: 'p',
      firstSeen: '2026-01-01T00:00:00.000Z',
      lastSeen: '2026-01-01T00:00:00.000Z',
      occurrences: 1,
      summary: 'crash',
      dismissed: false,
    };
    await writeFile(tmpFile, `not-valid-json\n${JSON.stringify(good)}\n{broken\n`, 'utf8');
    const entries = await readBaselines(tmpFile);
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe('c/ns/Pod/p');
  });

  it('re-throws non-ENOENT errors from readFile', async () => {
    // readFile on a directory throws EISDIR (not ENOENT) — must propagate.
    const dir = join(tmpdir(), `baseline-eisdir-${Date.now()}`);
    await mkdir(dir);
    try {
      await expect(readBaselines(dir)).rejects.toMatchObject({ code: 'EISDIR' });
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('skips blank lines', async () => {
    const entry: BaselineEntry = {
      key: 'k',
      cluster: 'c',
      namespace: 'ns',
      kind: 'Pod',
      name: 'p',
      firstSeen: '2026-01-01T00:00:00.000Z',
      lastSeen: '2026-01-01T00:00:00.000Z',
      occurrences: 1,
      summary: 's',
      dismissed: false,
    };
    await writeFile(tmpFile, `\n\n${JSON.stringify(entry)}\n\n`, 'utf8');
    const entries = await readBaselines(tmpFile);
    expect(entries).toHaveLength(1);
  });

});

describe('upsertBaseline', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = join(tmpdir(), `baseline-upsert-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  });

  afterEach(async () => {
    await rm(tmpFile, { force: true });
  });

  it('creates a new entry when key is not present', async () => {
    await upsertBaseline('prod', 'default', 'Pod', 'api', 'crashing', tmpFile);
    const entries = await readBaselines(tmpFile);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.key).toBe('prod/default/Pod/api');
    expect(e.cluster).toBe('prod');
    expect(e.namespace).toBe('default');
    expect(e.kind).toBe('Pod');
    expect(e.name).toBe('api');
    expect(e.occurrences).toBe(1);
    expect(e.summary).toBe('crashing');
    expect(e.dismissed).toBe(false);
    expect(Date.parse(e.firstSeen)).not.toBeNaN();
    expect(e.firstSeen).toBe(e.lastSeen);
  });

  it('increments occurrences and updates summary on subsequent calls', async () => {
    await upsertBaseline('prod', 'default', 'Pod', 'api', 'first summary', tmpFile);
    await upsertBaseline('prod', 'default', 'Pod', 'api', 'updated summary', tmpFile);
    const entries = await readBaselines(tmpFile);
    expect(entries).toHaveLength(1);
    expect(entries[0].occurrences).toBe(2);
    expect(entries[0].summary).toBe('updated summary');
  });

  it('preserves other entries when upserting a specific key', async () => {
    await upsertBaseline('prod', 'default', 'Pod', 'api', 'crash', tmpFile);
    await upsertBaseline('prod', 'default', 'Deployment', 'web', 'rollout stuck', tmpFile);
    await upsertBaseline('prod', 'default', 'Pod', 'api', 'still crashing', tmpFile);

    const entries = await readBaselines(tmpFile);
    expect(entries).toHaveLength(2);

    const pod = entries.find((e) => e.name === 'api')!;
    const dep = entries.find((e) => e.name === 'web')!;
    expect(pod.occurrences).toBe(2);
    expect(dep.occurrences).toBe(1);
  });

  it('preserves dismissed flag on existing entries', async () => {
    await upsertBaseline('prod', 'ns', 'Pod', 'x', 'issue', tmpFile);
    // Manually set dismissed = true
    const entries = await readBaselines(tmpFile);
    entries[0].dismissed = true;
    await writeFile(tmpFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    // Upsert again — dismissed should NOT be reset
    await upsertBaseline('prod', 'ns', 'Pod', 'x', 'new summary', tmpFile);
    const updated = await readBaselines(tmpFile);
    expect(updated[0].dismissed).toBe(true);
    expect(updated[0].occurrences).toBe(2);
  });

  it('creates the parent directory when it does not yet exist', async () => {
    const newDir = join(tmpdir(), `baseline-newdir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const filePath = join(newDir, 'sub', 'baselines.jsonl');
    try {
      await upsertBaseline('prod', 'default', 'Pod', 'api', 'crash', filePath);
      const entries = await readBaselines(filePath);
      expect(entries).toHaveLength(1);
      expect(entries[0].key).toBe('prod/default/Pod/api');
    } finally {
      await rm(newDir, { recursive: true, force: true });
    }
  });

  it('re-throws non-ENOENT write errors from writeFile', async () => {
    // Create a valid empty file so readBaselines succeeds, then make the next
    // writeFile call throw EACCES to exercise the else-throw at line 117.
    const tmpFile = join(tmpdir(), `baseline-write-err-${Date.now()}.jsonl`);
    await writeFile(tmpFile, '', 'utf8');
    vi.mocked(writeFile).mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    );
    try {
      await expect(
        upsertBaseline('prod', 'ns', 'Pod', 'x', 'sum', tmpFile),
      ).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      vi.mocked(writeFile).mockClear();
      await rm(tmpFile, { force: true });
    }
  });

  it('treats a missing occurrences field as 0 when incrementing', async () => {
    // Simulates legacy JSONL data where the field was absent: undefined ?? 0 = 0, then +1 = 1.
    const raw = {
      key: 'prod/default/Pod/api', cluster: 'prod', namespace: 'default', kind: 'Pod',
      name: 'api', firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z',
      summary: 'old', dismissed: false,
      // occurrences intentionally absent
    };
    await writeFile(tmpFile, JSON.stringify(raw) + '\n', 'utf8');
    await upsertBaseline('prod', 'default', 'Pod', 'api', 'updated', tmpFile);
    const entries = await readBaselines(tmpFile);
    expect(entries).toHaveLength(1);
    expect(entries[0].occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// queryTopBaselines
// ---------------------------------------------------------------------------
describe('queryTopBaselines', () => {
  const makeEntry = (name: string, occurrences: number, dismissed = false): BaselineEntry => ({
    key: `c/ns/Pod/${name}`,
    cluster: 'c',
    namespace: 'ns',
    kind: 'Pod',
    name,
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-01-01T00:00:00.000Z',
    occurrences,
    summary: 'some issue',
    dismissed,
  });

  it('returns empty array for empty input', () => {
    expect(queryTopBaselines([])).toEqual([]);
  });

  it('sorts by occurrences descending', () => {
    const entries = [makeEntry('a', 1), makeEntry('b', 5), makeEntry('c', 3)];
    const top = queryTopBaselines(entries);
    expect(top.map((e) => e.name)).toEqual(['b', 'c', 'a']);
  });

  it('excludes dismissed entries', () => {
    const entries = [makeEntry('a', 10, true), makeEntry('b', 2)];
    const top = queryTopBaselines(entries);
    expect(top).toHaveLength(1);
    expect(top[0].name).toBe('b');
  });

  it('caps at topN', () => {
    const entries = Array.from({ length: 20 }, (_, i) => makeEntry(`p${i}`, i));
    const top = queryTopBaselines(entries, 5);
    expect(top).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// formatBaselineDate
// ---------------------------------------------------------------------------
describe('formatBaselineDate', () => {
  it('returns the first 10 chars of an ISO date string', () => {
    expect(formatBaselineDate('2026-06-01T00:00:00.000Z')).toBe('2026-06-01');
  });

  it('returns a plain date string unchanged (already 10 chars)', () => {
    expect(formatBaselineDate('2026-06-01')).toBe('2026-06-01');
  });

  it('returns "unknown" for a number', () => {
    expect(formatBaselineDate(12345)).toBe('unknown');
  });

  it('returns "unknown" for null', () => {
    expect(formatBaselineDate(null)).toBe('unknown');
  });

  it('returns "unknown" for undefined', () => {
    expect(formatBaselineDate(undefined)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// formatBaselineEntry
// ---------------------------------------------------------------------------
describe('formatBaselineEntry', () => {
  const entry: BaselineEntry = {
    key: 'prod/ns/Pod/api',
    cluster: 'prod',
    namespace: 'ns',
    kind: 'Pod',
    name: 'api',
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-06-01T00:00:00.000Z',
    occurrences: 7,
    summary: 'CrashLoopBackOff',
    dismissed: false,
  };

  it('includes kind, name, namespace, and cluster in the heading', () => {
    const result = formatBaselineEntry(entry);
    expect(result).toContain('Pod/api');
    expect(result).toContain('ns');
    expect(result).toContain('prod');
  });

  it('formats firstSeen and lastSeen as date-only strings', () => {
    const result = formatBaselineEntry(entry);
    expect(result).toContain('First seen**: 2026-01-01');
    expect(result).toContain('Last seen**: 2026-06-01');
  });

  it('includes occurrence count', () => {
    expect(formatBaselineEntry(entry)).toContain('7');
  });

  it('includes the summary inside a fenced code block', () => {
    const result = formatBaselineEntry(entry);
    expect(result).toContain('```\nCrashLoopBackOff\n```');
  });

  it('replaces backticks in summary with single quotes', () => {
    const tickEntry = { ...entry, summary: 'failed to pull `image:latest`' };
    const result = formatBaselineEntry(tickEntry);
    expect(result).toContain("failed to pull 'image:latest'");
    expect(result).not.toMatch(/```\n.*`.*\n```/);
  });

  it('falls back to "unknown" for non-string date fields', () => {
    const badDates = {
      ...entry,
      firstSeen: 99 as unknown as string,
      lastSeen: null as unknown as string,
    };
    const result = formatBaselineEntry(badDates);
    expect(result).toMatch(/First seen\*\*: unknown/);
    expect(result).toMatch(/Last seen\*\*: unknown/);
  });
});

// ---------------------------------------------------------------------------
// buildBaselineContext
// ---------------------------------------------------------------------------
describe('buildBaselineContext', () => {
  it('returns empty string for empty input', () => {
    expect(buildBaselineContext([])).toBe('');
  });

  it('includes relevant fields in output', () => {
    const entry: BaselineEntry = {
      key: 'prod/ns/Pod/api',
      cluster: 'prod',
      namespace: 'ns',
      kind: 'Pod',
      name: 'api',
      firstSeen: '2026-01-01T00:00:00.000Z',
      lastSeen: '2026-06-01T00:00:00.000Z',
      occurrences: 7,
      summary: 'CrashLoopBackOff due to missing SECRET_KEY',
      dismissed: false,
    };
    const ctx = buildBaselineContext([entry]);
    expect(ctx).toContain('Pod/api');
    expect(ctx).toContain('ns');
    expect(ctx).toContain('prod');
    expect(ctx).toContain('7');
    expect(ctx).toContain('CrashLoopBackOff');
  });

  it('marks context as historical / not an instruction', () => {
    const entry: BaselineEntry = {
      key: 'x',
      cluster: 'c',
      namespace: 'ns',
      kind: 'Pod',
      name: 'p',
      firstSeen: '2026-01-01T00:00:00.000Z',
      lastSeen: '2026-01-01T00:00:00.000Z',
      occurrences: 1,
      summary: 'test',
      dismissed: false,
    };
    const ctx = buildBaselineContext([entry]);
    expect(ctx.toLowerCase()).toContain('historical');
  });

  it('falls back to "unknown" when firstSeen or lastSeen is not a string', () => {
    // Covers the false arms of the typeof guards in the template literal.
    const entry = {
      key: 'x', cluster: 'c', namespace: 'ns', kind: 'Pod', name: 'p',
      firstSeen: 12345 as unknown as string,
      lastSeen: null as unknown as string,
      occurrences: 1, summary: 'test', dismissed: false,
    } as BaselineEntry;
    const ctx = buildBaselineContext([entry]);
    expect(ctx).toContain('unknown');
  });
});

// ---------------------------------------------------------------------------
// scanFindingFields
// ---------------------------------------------------------------------------
describe('scanFindingFields', () => {
  it('finds Resource and Message fields within the scan window', () => {
    const lines = ['- **Resource**: Pod/api in prod', '- **Message**: crashing'];
    expect(scanFindingFields(lines, 0)).toEqual({
      kind: 'Pod',
      name: 'api',
      namespace: 'prod',
      summary: 'crashing',
    });
  });

  it('defaults namespace to "cluster" when Resource has no explicit namespace', () => {
    const lines = ['- **Resource**: Node/worker-1', '- **Message**: MemoryPressure'];
    expect(scanFindingFields(lines, 0)).toMatchObject({ kind: 'Node', name: 'worker-1', namespace: 'cluster' });
  });

  it('stops at the next Severity marker without finding fields', () => {
    const lines = ['- **Severity**: warning', '- **Resource**: Pod/api in prod'];
    expect(scanFindingFields(lines, 0)).toEqual({ kind: '', name: '', namespace: 'cluster', summary: '' });
  });

  it('only scans up to 6 lines from startIdx', () => {
    const lines = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', '- **Resource**: Pod/late in prod'];
    expect(scanFindingFields(lines, 0).kind).toBe('');
  });

  it('returns empty fields for an empty scan window', () => {
    expect(scanFindingFields([], 0)).toEqual({ kind: '', name: '', namespace: 'cluster', summary: '' });
  });
});

// ---------------------------------------------------------------------------
// parseTriageFindings
// ---------------------------------------------------------------------------
describe('parseTriageFindings', () => {
  it('returns empty array for text with no findings', () => {
    expect(parseTriageFindings('No issues found.')).toEqual([]);
  });

  it('parses a single critical finding', () => {
    const text = [
      '## Findings',
      '- **Severity**: critical',
      '- **Resource**: Pod/api-7f9d in prod',
      '- **Message**: pod is in CrashLoopBackOff state',
      '- **Suggested remediation**: kubectl delete pod api-7f9d -n prod',
    ].join('\n');

    const findings = parseTriageFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].kind).toBe('Pod');
    expect(findings[0].name).toBe('api-7f9d');
    expect(findings[0].namespace).toBe('prod');
    expect(findings[0].summary).toContain('CrashLoopBackOff');
  });

  it('parses a warning finding', () => {
    const text = [
      '- **Severity**: warning',
      '- **Resource**: Deployment/web in staging',
      '- **Message**: 1/3 replicas unavailable',
    ].join('\n');

    const findings = parseTriageFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].namespace).toBe('staging');
  });

  it('skips info findings', () => {
    const text = [
      '- **Severity**: info',
      '- **Resource**: Pod/worker in default',
      '- **Message**: pod has been running for 30 days',
    ].join('\n');
    expect(parseTriageFindings(text)).toHaveLength(0);
  });

  it('parses multiple findings from a full triage report', () => {
    const text = [
      '1. **Nodes** — all healthy',
      '2. **Pods**',
      '- **Severity**: critical',
      '- **Resource**: Pod/db-0 in prod',
      '- **Message**: OOMKilled repeatedly',
      '- **Suggested remediation**: kubectl delete pod db-0 -n prod',
      '',
      '- **Severity**: warning',
      '- **Resource**: Deployment/frontend in prod',
      '- **Message**: rollout stuck at 2/3',
      '- **Suggested remediation**: kubectl rollout restart deployment/frontend -n prod',
    ].join('\n');

    const findings = parseTriageFindings(text);
    expect(findings).toHaveLength(2);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].name).toBe('db-0');
    expect(findings[1].severity).toBe('warning');
    expect(findings[1].name).toBe('frontend');
  });

  it('handles resource without explicit namespace (cluster-scoped)', () => {
    const text = [
      '- **Severity**: warning',
      '- **Resource**: Node/worker-1',
      '- **Message**: MemoryPressure condition is True',
    ].join('\n');
    const findings = parseTriageFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('Node');
    expect(findings[0].name).toBe('worker-1');
    expect(findings[0].namespace).toBe('cluster');
  });

  it('breaks inner scan and skips push when a second Severity marker appears before Resource', () => {
    // The j-loop hits a second **Severity** line → break (branch 210 arm true).
    // kind/name remain empty → finding not pushed (branch 229 arm false).
    const text = [
      '- **Severity**: critical',  // i=0
      '- **Severity**: warning',   // j=1: Severity test → break; then i=1 processes this
      '- **Resource**: Pod/api in prod',
      '- **Message**: crashing',
    ].join('\n');
    const findings = parseTriageFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings.every((f) => f.severity !== 'critical')).toBe(true);
  });

  it('skips non-resource lines before finding Resource (covers resMatch-null and non-message paths)', () => {
    // j=1 is a plain text line: enters !kind block but resMatch=null (branch 213 arm false),
    // then enters !summary block but msgMatch=null (branch 222 arm false),
    // then kind&&summary both empty → no early break (branch 226 arm false).
    const text = [
      '- **Severity**: critical',
      'Node details: see runbook',  // non-Resource, non-Message line
      '- **Resource**: Pod/api in prod',
      '- **Message**: OOMKilled',
    ].join('\n');
    const findings = parseTriageFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('Pod');
    expect(findings[0].summary).toContain('OOMKilled');
  });

  it('handles Message appearing before Resource (summary-already-set path)', () => {
    // j=1 sets summary; j=2 sets kind via continue; j=3 has !summary=false (branch 220 arm false).
    const text = [
      '- **Severity**: critical',
      '- **Message**: crashing',               // sets summary at j=1
      '- **Resource**: Pod/api in prod',        // sets kind at j=2 via continue
      '- **Suggested remediation**: kubectl delete pod api -n prod', // j=3: !summary=false
    ].join('\n');
    const findings = parseTriageFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].summary).toBe('crashing');
  });

  it('uses fallback summary when Resource is found but Message is absent', () => {
    // summary stays '' → findings.push uses the || fallback string (branch 230 arm false).
    const text = [
      '- **Severity**: critical',
      '- **Resource**: Pod/api in prod',
      '- **Suggested remediation**: kubectl delete pod api -n prod',
    ].join('\n');
    const findings = parseTriageFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].summary).toMatch(/critical.*Pod\/api/i);
  });
});

// ---------------------------------------------------------------------------
// inferDiagnosisSeverity
// ---------------------------------------------------------------------------
describe('inferDiagnosisSeverity', () => {
  it('returns warning for generic diagnosis', () => {
    expect(inferDiagnosisSeverity('The pod is in a bad state')).toBe('warning');
  });

  it('returns critical when "critical" appears in the text', () => {
    expect(inferDiagnosisSeverity('This is a critical issue.')).toBe('critical');
  });

  it('returns critical when "Critical" appears (case-insensitive)', () => {
    expect(inferDiagnosisSeverity('This is a Critical severity issue.')).toBe('critical');
  });

  it('is case-insensitive', () => {
    expect(inferDiagnosisSeverity('CRITICAL: cluster-impacting failure')).toBe('critical');
  });

  it('returns warning when "critical" is explicitly negated ("not critical")', () => {
    expect(inferDiagnosisSeverity('This is not critical, just a transient blip.')).toBe('warning');
  });

  it('returns warning for "no critical condition"', () => {
    expect(inferDiagnosisSeverity('There is no critical condition detected here.')).toBe('warning');
  });

  it('returns warning for "non-critical"', () => {
    expect(inferDiagnosisSeverity('This is a non-critical issue that can wait.')).toBe('warning');
  });

  it('returns warning for negation with a filler word ("not a critical")', () => {
    expect(inferDiagnosisSeverity('This is not a critical issue.')).toBe('warning');
  });

  it('returns critical when a negated mention is followed by a genuine critical mention', () => {
    expect(
      inferDiagnosisSeverity('The sidecar is not critical, but the database outage is critical.'),
    ).toBe('critical');
  });

  it('does not let a negation in an earlier clause suppress a critical mention in a later clause', () => {
    expect(inferDiagnosisSeverity('No fallback is working; critical outage persists.')).toBe('critical');
  });

  it('treats "and" as a clause boundary between an unrelated negation and a critical mention', () => {
    expect(
      inferDiagnosisSeverity('No workaround exists and this critical outage needs immediate remediation'),
    ).toBe('critical');
  });
});

// ---------------------------------------------------------------------------
// truncateSummary
// ---------------------------------------------------------------------------
describe('truncateSummary', () => {
  it('returns text unchanged when within limit', () => {
    expect(truncateSummary('short text', 300)).toBe('short text');
  });

  it('truncates long text and appends ellipsis', () => {
    const long = 'a'.repeat(400);
    const result = truncateSummary(long, 300);
    expect(result.length).toBeLessThanOrEqual(300);
    expect(result.endsWith('…')).toBe(true);
  });

  it('collapses internal whitespace', () => {
    expect(truncateSummary('hello   world\n  foo')).toBe('hello world foo');
  });
});

// ---------------------------------------------------------------------------
// resolveBaselineFilePath
// ---------------------------------------------------------------------------
describe('resolveBaselineFilePath', () => {
  it('returns configured absolute path unchanged', () => {
    const result = resolveBaselineFilePath('/custom/path/baselines.jsonl', '/any/dir');
    expect(result).toBe('/custom/path/baselines.jsonl');
  });

  it('resolves relative configured path against defaultDir', () => {
    const result = resolveBaselineFilePath('data/baselines.jsonl', '/home/user/heimdall');
    expect(result).toBe('/home/user/heimdall/data/baselines.jsonl');
  });

  it('returns default path under scenarios/ when not configured', () => {
    const result = resolveBaselineFilePath(null, '/home/user/heimdall');
    expect(result).toBe('/home/user/heimdall/scenarios/baselines.jsonl');
  });

  it('returns default path when undefined', () => {
    const result = resolveBaselineFilePath(undefined, '/home/user/heimdall');
    expect(result).toBe('/home/user/heimdall/scenarios/baselines.jsonl');
  });
});
