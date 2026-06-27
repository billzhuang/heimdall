import { describe, it, expect } from 'vitest';
import {
  buildTriagePrompt,
  compareSeverity,
  parseSeverity,
  resolveNamespaceScope,
  TRIAGE_CATEGORIES,
  type Severity,
} from '../triage.ts';

describe('buildTriagePrompt', () => {
  it('covers all 7 triage categories in order', () => {
    const prompt = buildTriagePrompt();
    // Map category keys to the heading labels used in the prompt.
    const categoryLabels: Record<string, string> = {
      nodes: 'Nodes',
      pods: 'Pods',
      workloads: 'Workloads',
      events: 'Events',
      pvcs: 'PVCs',
      jobs: 'Jobs',
      capi: 'CAPI drift',
    };
    const positions = TRIAGE_CATEGORIES.map((cat) => {
      const label = categoryLabels[cat];
      return { cat, pos: prompt.indexOf(label) };
    });
    for (const { pos } of positions) {
      expect(pos).toBeGreaterThan(-1);
    }
    // Verify ordering: each category appears after the previous one.
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i].pos).toBeGreaterThan(positions[i - 1].pos);
    }
  });

  it('scopes kubectl flags to a specific namespace', () => {
    const prompt = buildTriagePrompt({ namespace: 'prod' });
    expect(prompt).toContain('namespace "prod"');
    expect(prompt).toContain('-n prod');
    expect(prompt).not.toContain('-A');
  });

  it('uses -A flag when allNamespaces is true', () => {
    const prompt = buildTriagePrompt({ allNamespaces: true });
    expect(prompt).toContain('all namespaces');
    expect(prompt).toContain('-A');
  });

  it('uses default-namespace scope when no options given', () => {
    const prompt = buildTriagePrompt();
    expect(prompt).toContain('default namespace');
    expect(prompt).not.toContain('-A');
  });

  it('defines all three severity levels', () => {
    const prompt = buildTriagePrompt();
    expect(prompt).toContain('critical');
    expect(prompt).toContain('warning');
    expect(prompt).toContain('info');
  });

  it('instructs agent never to execute remediation commands itself', () => {
    const prompt = buildTriagePrompt();
    expect(prompt).toMatch(/never execute it yourself/i);
  });

  it('includes a summary instruction', () => {
    const prompt = buildTriagePrompt();
    expect(prompt).toContain('Triage complete:');
  });

  it('namespace option takes precedence over allNamespaces', () => {
    // When namespace is set, we use -n <ns> not -A
    const prompt = buildTriagePrompt({ namespace: 'staging', allNamespaces: true });
    expect(prompt).toContain('-n staging');
    expect(prompt).not.toContain('-A');
  });

  it('generates a multi-cluster prompt when contexts is set', () => {
    const prompt = buildTriagePrompt({ contexts: ['cluster-a', 'cluster-b'] });
    expect(prompt).toContain('cluster-a');
    expect(prompt).toContain('cluster-b');
    expect(prompt).toMatch(/multi-cluster/i);
    expect(prompt).toContain('multi-cluster-investigator');
  });

  it('multi-cluster prompt lists all supplied contexts', () => {
    const contexts = ['prod-us-east', 'prod-eu-west', 'staging'];
    const prompt = buildTriagePrompt({ contexts });
    for (const ctx of contexts) {
      expect(prompt).toContain(ctx);
    }
  });

  it('multi-cluster prompt includes namespace scope when namespace is set', () => {
    const prompt = buildTriagePrompt({ contexts: ['cluster-a', 'cluster-b'], namespace: 'prod' });
    expect(prompt).toContain('"prod"');
    expect(prompt).toMatch(/multi-cluster/i);
  });

  it('multi-cluster prompt includes all-namespace scope when allNamespaces is set', () => {
    const prompt = buildTriagePrompt({ contexts: ['cluster-a'], allNamespaces: true });
    expect(prompt).toMatch(/all namespaces/i);
  });

  it('falls back to single-cluster prompt when contexts is empty array', () => {
    const prompt = buildTriagePrompt({ contexts: [] });
    expect(prompt).toContain('default namespace');
    expect(prompt).not.toMatch(/multi-cluster-investigator/i);
  });
});

describe('parseSeverity', () => {
  it.each<[string, Severity]>([
    ['critical error', 'critical'],
    ['CRITICAL', 'critical'],
    ['warning: pod is pending', 'warning'],
    ['WARNING', 'warning'],
    ['info: PDB present', 'info'],
    ['INFO', 'info'],
  ])('parses "%s" → %s', (text, expected) => {
    expect(parseSeverity(text)).toBe(expected);
  });

  it('returns undefined for unrecognised text', () => {
    expect(parseSeverity('unknown severity')).toBeUndefined();
    expect(parseSeverity('')).toBeUndefined();
  });
});

describe('compareSeverity', () => {
  it('orders critical before warning before info', () => {
    expect(compareSeverity('critical', 'warning')).toBeLessThan(0);
    expect(compareSeverity('warning', 'info')).toBeLessThan(0);
    expect(compareSeverity('critical', 'info')).toBeLessThan(0);
  });

  it('returns 0 for equal severities', () => {
    expect(compareSeverity('critical', 'critical')).toBe(0);
    expect(compareSeverity('warning', 'warning')).toBe(0);
    expect(compareSeverity('info', 'info')).toBe(0);
  });

  it('reverses correctly', () => {
    expect(compareSeverity('info', 'critical')).toBeGreaterThan(0);
    expect(compareSeverity('info', 'warning')).toBeGreaterThan(0);
    expect(compareSeverity('warning', 'critical')).toBeGreaterThan(0);
  });

  it('can sort an array of findings by severity', () => {
    const severities: Severity[] = ['info', 'critical', 'warning', 'critical', 'info'];
    const sorted = [...severities].sort(compareSeverity);
    expect(sorted).toEqual(['critical', 'critical', 'warning', 'info', 'info']);
  });
});

describe('parseSeverity — priority ordering', () => {
  it('returns critical when text contains both critical and warning', () => {
    expect(parseSeverity('critical warning detected')).toBe('critical');
  });

  it('returns warning when text contains both warning and info', () => {
    expect(parseSeverity('warning: info logged')).toBe('warning');
  });
});

describe('buildTriagePrompt — SLO evaluation step', () => {
  const slos = [
    {
      name: 'API availability',
      metric: 'sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))',
      target: 0.999,
      window: '30d',
      budget: 0.001,
    },
    {
      name: 'p99 latency',
      metric: 'histogram_quantile(0.99, rate(http_duration_seconds_bucket[5m]))',
      target: 0.995,
      window: '7d',
      budget: 0.005,
    },
  ];

  it('appends step 8 SLO evaluation when slos are provided', () => {
    const prompt = buildTriagePrompt({ slos });
    expect(prompt).toContain('8. **SLO evaluation**');
    expect(prompt).toContain('slo-evaluator');
  });

  it('lists each SLO name and metric in the prompt', () => {
    const prompt = buildTriagePrompt({ slos });
    expect(prompt).toContain('API availability');
    expect(prompt).toContain('p99 latency');
    expect(prompt).toContain('http_requests_total');
    expect(prompt).toContain('http_duration_seconds_bucket');
  });

  it('includes burn rate and remaining budget formulas', () => {
    const prompt = buildTriagePrompt({ slos });
    expect(prompt).toContain('burn_rate');
    expect(prompt).toContain('remaining_budget');
    expect(prompt).toMatch(/burn_rate > 1/);
  });

  it('includes SLO budget, target, and window for each entry', () => {
    const prompt = buildTriagePrompt({ slos: [slos[0]] });
    expect(prompt).toContain('0.001');
    expect(prompt).toContain('0.999');
    expect(prompt).toContain('30d');
  });

  it('does not append the SLO step when slos is empty', () => {
    expect(buildTriagePrompt({ slos: [] })).not.toContain('SLO evaluation');
    expect(buildTriagePrompt()).not.toContain('SLO evaluation');
  });

  it('SLO step references prometheus_query tool', () => {
    expect(buildTriagePrompt({ slos })).toContain('prometheus_query');
  });
});

describe('buildTriagePrompt — multi-cluster details', () => {
  it('includes CAPI investigation instructions', () => {
    const prompt = buildTriagePrompt({ contexts: ['prod', 'staging'] });
    expect(prompt).toMatch(/CAPI/i);
    expect(prompt).toContain('capi-investigator');
  });

  it('specifies per-cluster summary and cross-cluster findings section', () => {
    const prompt = buildTriagePrompt({ contexts: ['prod', 'staging'] });
    expect(prompt).toMatch(/per-cluster/i);
    expect(prompt).toMatch(/cross-cluster/i);
  });

  it('ends with the multi-cluster triage summary line', () => {
    const prompt = buildTriagePrompt({ contexts: ['prod'] });
    expect(prompt).toContain('Multi-cluster triage complete:');
  });
});

// ---------------------------------------------------------------------------
// resolveNamespaceScope
// ---------------------------------------------------------------------------

describe('resolveNamespaceScope — default (no options)', () => {
  it('returns empty suffixes and "the default namespace" label', () => {
    const scope = resolveNamespaceScope({});
    expect(scope.kubectlSuffix).toBe('');
    expect(scope.scopeLabel).toBe('the default namespace');
    expect(scope.multiClusterSuffix).toBe('');
  });

  it('returns the same defaults when both namespace and allNamespaces are falsy', () => {
    expect(resolveNamespaceScope({ namespace: undefined, allNamespaces: false }))
      .toEqual({ kubectlSuffix: '', scopeLabel: 'the default namespace', multiClusterSuffix: '' });
  });
});

describe('resolveNamespaceScope — specific namespace', () => {
  it('returns -n suffix, quoted label, and "scoped to namespace" multi-cluster suffix', () => {
    const scope = resolveNamespaceScope({ namespace: 'prod' });
    expect(scope.kubectlSuffix).toBe(' -n prod');
    expect(scope.scopeLabel).toBe('namespace "prod"');
    expect(scope.multiClusterSuffix).toBe(' scoped to namespace "prod"');
  });

  it('embeds the namespace name verbatim (no sanitisation)', () => {
    const scope = resolveNamespaceScope({ namespace: 'my-team-staging' });
    expect(scope.kubectlSuffix).toBe(' -n my-team-staging');
    expect(scope.scopeLabel).toBe('namespace "my-team-staging"');
    expect(scope.multiClusterSuffix).toBe(' scoped to namespace "my-team-staging"');
  });

  it('namespace takes precedence over allNamespaces when both are set', () => {
    const scope = resolveNamespaceScope({ namespace: 'prod', allNamespaces: true });
    expect(scope.kubectlSuffix).toBe(' -n prod');
    expect(scope.scopeLabel).toBe('namespace "prod"');
    expect(scope.multiClusterSuffix).toBe(' scoped to namespace "prod"');
  });
});

describe('resolveNamespaceScope — all namespaces', () => {
  it('returns -A suffix, "all namespaces" label, and " across all namespaces" multi-cluster suffix', () => {
    const scope = resolveNamespaceScope({ allNamespaces: true });
    expect(scope.kubectlSuffix).toBe(' -A');
    expect(scope.scopeLabel).toBe('all namespaces');
    expect(scope.multiClusterSuffix).toBe(' across all namespaces');
  });

  it('does not use -A when allNamespaces is false', () => {
    const scope = resolveNamespaceScope({ allNamespaces: false });
    expect(scope.kubectlSuffix).toBe('');
    expect(scope.scopeLabel).toBe('the default namespace');
  });
});
