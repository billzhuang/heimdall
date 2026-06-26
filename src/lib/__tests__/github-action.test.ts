import { describe, it, expect } from 'vitest';
import {
  severityEmoji,
  normaliseSeverity,
  severityAtLeast,
  findingToOutputs,
  renderJobSummary,
  renderTriageJobSummary,
  detectTriageSeverity,
} from '../github-action.ts';
import type { OneShotFinding } from '../format-output.ts';

// Minimal stub that satisfies OneShotFinding
const baseFinding: OneShotFinding = {
  summary: 'API pod crash-looping due to OOM',
  answer: 'The api pod is OOMKilled repeatedly because the memory limit is set to 128Mi.',
  severity: 'warning',
  suggestedCommands: ['kubectl describe pod api-0 -n prod'],
};

describe('severityEmoji', () => {
  it('maps critical to red circle', () => {
    expect(severityEmoji('critical')).toBe('🔴');
  });
  it('maps warning to yellow circle', () => {
    expect(severityEmoji('warning')).toBe('🟡');
  });
  it('maps info to blue circle', () => {
    expect(severityEmoji('info')).toBe('🔵');
  });
  it('maps ok to green circle', () => {
    expect(severityEmoji('ok')).toBe('🟢');
  });
});

describe('normaliseSeverity', () => {
  it('passes through known values', () => {
    expect(normaliseSeverity('critical')).toBe('critical');
    expect(normaliseSeverity('warning')).toBe('warning');
    expect(normaliseSeverity('info')).toBe('info');
    expect(normaliseSeverity('ok')).toBe('ok');
  });

  it('is case-insensitive', () => {
    expect(normaliseSeverity('CRITICAL')).toBe('critical');
    expect(normaliseSeverity('Warning')).toBe('warning');
  });

  it('trims whitespace', () => {
    expect(normaliseSeverity('  warning  ')).toBe('warning');
  });

  it('defaults unknown values to info', () => {
    expect(normaliseSeverity('unknown')).toBe('info');
    expect(normaliseSeverity('')).toBe('info');
    expect(normaliseSeverity(null)).toBe('info');
    expect(normaliseSeverity(undefined)).toBe('info');
  });
});

describe('severityAtLeast', () => {
  it('critical >= all thresholds', () => {
    expect(severityAtLeast('critical', 'critical')).toBe(true);
    expect(severityAtLeast('critical', 'warning')).toBe(true);
    expect(severityAtLeast('critical', 'info')).toBe(true);
    expect(severityAtLeast('critical', 'ok')).toBe(true);
  });

  it('ok is only >= ok', () => {
    expect(severityAtLeast('ok', 'ok')).toBe(true);
    expect(severityAtLeast('ok', 'info')).toBe(false);
    expect(severityAtLeast('ok', 'warning')).toBe(false);
    expect(severityAtLeast('ok', 'critical')).toBe(false);
  });

  it('warning is >= warning and below', () => {
    expect(severityAtLeast('warning', 'warning')).toBe(true);
    expect(severityAtLeast('warning', 'info')).toBe(true);
    expect(severityAtLeast('warning', 'ok')).toBe(true);
    expect(severityAtLeast('warning', 'critical')).toBe(false);
  });

  it('info is >= info and ok', () => {
    expect(severityAtLeast('info', 'info')).toBe(true);
    expect(severityAtLeast('info', 'ok')).toBe(true);
    expect(severityAtLeast('info', 'warning')).toBe(false);
  });
});

describe('findingToOutputs', () => {
  it('maps severity, summary, answer', () => {
    const outputs = findingToOutputs(baseFinding);
    expect(outputs['severity']).toBe('warning');
    expect(outputs['summary']).toBe('API pod crash-looping due to OOM');
    expect(outputs['answer']).toContain('OOMKilled');
  });

  it('joins suggested commands with newline', () => {
    const finding: OneShotFinding = {
      ...baseFinding,
      suggestedCommands: ['kubectl get pods', 'kubectl describe pod api-0'],
    };
    const outputs = findingToOutputs(finding);
    expect(outputs['suggested-commands']).toBe('kubectl get pods\nkubectl describe pod api-0');
  });

  it('joins remediation steps with newline', () => {
    const finding: OneShotFinding = {
      ...baseFinding,
      remediationSteps: ['Increase memory limit', 'Add HPA'],
    };
    const outputs = findingToOutputs(finding);
    expect(outputs['remediation-steps']).toBe('Increase memory limit\nAdd HPA');
  });

  it('defaults empty arrays to empty string', () => {
    const finding: OneShotFinding = { ...baseFinding, suggestedCommands: [] };
    const outputs = findingToOutputs(finding);
    expect(outputs['suggested-commands']).toBe('');
  });

  it('normalises severity', () => {
    const finding: OneShotFinding = { ...baseFinding, severity: 'CRITICAL' as 'critical' };
    const outputs = findingToOutputs(finding);
    expect(outputs['severity']).toBe('critical');
  });

  it('serialises validity score', () => {
    const finding: OneShotFinding = { ...baseFinding, validityScore: 0.85 };
    const outputs = findingToOutputs(finding);
    expect(outputs['validity-score']).toBe('0.85');
  });

  it('handles undefined validity score', () => {
    const outputs = findingToOutputs(baseFinding);
    expect(outputs['validity-score']).toBe('');
  });
});

describe('renderJobSummary', () => {
  it('includes severity in header', () => {
    const md = renderJobSummary(baseFinding);
    expect(md).toContain('WARNING');
    expect(md).toContain('🟡');
  });

  it('includes summary section', () => {
    const md = renderJobSummary(baseFinding);
    expect(md).toContain('### Summary');
    expect(md).toContain('crash-looping');
  });

  it('includes answer section', () => {
    const md = renderJobSummary(baseFinding);
    expect(md).toContain('### Answer');
    expect(md).toContain('OOMKilled');
  });

  it('includes the prompt when supplied', () => {
    const md = renderJobSummary(baseFinding, 'Why is api crashing?');
    expect(md).toContain('Why is api crashing?');
  });

  it('omits query line when prompt not supplied', () => {
    const md = renderJobSummary(baseFinding);
    expect(md).not.toContain('**Query:**');
  });

  it('renders causal chain as a bullet list', () => {
    const finding: OneShotFinding = {
      ...baseFinding,
      causalChain: ['Memory pressure', 'OOM kill'],
    };
    const md = renderJobSummary(finding);
    expect(md).toContain('### Causal Chain');
    expect(md).toContain('- Memory pressure');
    expect(md).toContain('- OOM kill');
  });

  it('renders remediation steps as a bullet list', () => {
    const finding: OneShotFinding = {
      ...baseFinding,
      remediationSteps: ['Increase limit', 'Add VPA'],
    };
    const md = renderJobSummary(finding);
    expect(md).toContain('### Remediation Steps');
    expect(md).toContain('- Increase limit');
  });

  it('renders suggested commands in a code block', () => {
    const md = renderJobSummary(baseFinding);
    expect(md).toContain('### Suggested Commands');
    expect(md).toContain('```');
    expect(md).toContain('kubectl describe pod api-0 -n prod');
  });

  it('omits sections that are empty or missing', () => {
    const finding: OneShotFinding = {
      summary: 'All clear',
      answer: 'No issues found.',
      severity: 'info',
      suggestedCommands: [],
    };
    const md = renderJobSummary(finding);
    expect(md).not.toContain('Causal Chain');
    expect(md).not.toContain('Remediation');
    expect(md).not.toContain('Suggested Commands');
  });

  it('includes Heimdall branding footer', () => {
    const md = renderJobSummary(baseFinding);
    expect(md).toContain('Powered by');
    expect(md).toContain('Heimdall');
  });
});

describe('detectTriageSeverity', () => {
  it('returns critical when "critical" starts a line', () => {
    expect(detectTriageSeverity('CRITICAL: node NotReady')).toBe('critical');
  });

  it('critical takes precedence over warning', () => {
    expect(detectTriageSeverity('warning: pod restarts\ncritical: node NotReady')).toBe('critical');
  });

  it('returns warning when present without critical', () => {
    expect(detectTriageSeverity('WARNING: high memory usage')).toBe('warning');
  });

  it('returns info when only info appears at line start', () => {
    expect(detectTriageSeverity('INFO: all pods running')).toBe('info');
  });

  it('returns ok for clean reports with no severity keywords', () => {
    expect(detectTriageSeverity('All systems operational.')).toBe('ok');
  });

  it('is case-insensitive', () => {
    expect(detectTriageSeverity('Critical issue found')).toBe('critical');
    expect(detectTriageSeverity('Warning: latency')).toBe('warning');
  });

  it('does not match hyphenated service names', () => {
    // "critical-api-service" should NOT trigger critical
    expect(detectTriageSeverity('Checking critical-api-service pod health')).toBe('ok');
    // "warning-controller" should NOT trigger warning
    expect(detectTriageSeverity('warning-controller deployment found')).toBe('ok');
  });

  it('matches keyword at start of line with leading whitespace', () => {
    expect(detectTriageSeverity('  critical node down')).toBe('critical');
    expect(detectTriageSeverity('\n  warning: high load')).toBe('warning');
  });
});

describe('renderTriageJobSummary', () => {
  it('includes severity header from report content', () => {
    const md = renderTriageJobSummary('critical: node is down');
    expect(md).toContain('CRITICAL');
    expect(md).toContain('🔴');
  });

  it('wraps report in a collapsible details block', () => {
    const md = renderTriageJobSummary('INFO: all ok');
    expect(md).toContain('<details>');
    expect(md).toContain('<summary>');
    expect(md).toContain('</details>');
  });

  it('includes the raw report text', () => {
    const report = 'warning: high memory usage detected';
    const md = renderTriageJobSummary(report);
    expect(md).toContain(report);
  });

  it('includes Heimdall branding footer', () => {
    const md = renderTriageJobSummary('ok');
    expect(md).toContain('Powered by');
    expect(md).toContain('Heimdall');
  });
});
