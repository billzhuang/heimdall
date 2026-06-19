import { describe, it, expect } from 'vitest';
import {
  buildTriagePrompt,
  compareSeverity,
  parseSeverity,
  TRIAGE_CATEGORIES,
  type Severity,
} from '../triage.ts';

describe('buildTriagePrompt', () => {
  it('covers all 6 triage categories in order', () => {
    const prompt = buildTriagePrompt();
    // Map category keys to the heading labels used in the prompt.
    const categoryLabels: Record<string, string> = {
      nodes: 'Nodes',
      pods: 'Pods',
      workloads: 'Workloads',
      events: 'Events',
      pvcs: 'PVCs',
      jobs: 'Jobs',
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

  it('uses default scope when no options given', () => {
    const prompt = buildTriagePrompt();
    expect(prompt).toContain('default namespace');
    expect(prompt).toContain('-A');
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

  it('namespace option overrides allNamespaces', () => {
    // When namespace is set, we use -n <ns> not -A
    const prompt = buildTriagePrompt({ namespace: 'staging', allNamespaces: true });
    expect(prompt).toContain('-n staging');
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
