/**
 * Helpers for the Heimdall GitHub composite action.
 *
 * All functions are pure (no I/O) so they can be unit-tested without any
 * external dependencies or environment setup.
 */
import type { OneShotFinding } from './format-output.ts';

export type ActionSeverity = 'critical' | 'warning' | 'info' | 'ok';

/** Map a finding's severity to an emoji for GitHub job summaries. */
export function severityEmoji(severity: ActionSeverity): string {
  switch (severity) {
    case 'critical': return '🔴';
    case 'warning':  return '🟡';
    case 'info':     return '🔵';
    case 'ok':       return '🟢';
  }
}

/** Normalise a raw severity string (from OneShotFinding or triage output). */
export function normaliseSeverity(raw: string | undefined | null): ActionSeverity {
  switch ((raw ?? '').toLowerCase().trim()) {
    case 'critical': return 'critical';
    case 'warning':  return 'warning';
    case 'ok':       return 'ok';
    default:         return 'info';
  }
}

/**
 * Returns true when `found` meets or exceeds the `threshold`.
 * Order: critical > warning > info > ok.
 */
export function severityAtLeast(found: ActionSeverity, threshold: ActionSeverity): boolean {
  const rank: Record<ActionSeverity, number> = {
    critical: 3,
    warning:  2,
    info:     1,
    ok:       0,
  };
  return rank[found] >= rank[threshold];
}

/** Convert an OneShotFinding into a GitHub Actions output map. */
export function findingToOutputs(finding: OneShotFinding): Record<string, string> {
  const severity = normaliseSeverity(finding.severity);
  return {
    severity,
    summary: finding.summary ?? '',
    answer: finding.answer ?? '',
    'validity-score': String(finding.validityScore ?? ''),
    'remediation-steps': (finding.remediationSteps ?? []).join('\n'),
    'suggested-commands': (finding.suggestedCommands ?? []).join('\n'),
  };
}

/**
 * Render a GitHub job-summary Markdown document from a finding.
 * The result is safe to append directly to $GITHUB_STEP_SUMMARY.
 */
export function renderJobSummary(finding: OneShotFinding, prompt?: string): string {
  const severity = normaliseSeverity(finding.severity);
  const emoji = severityEmoji(severity);
  const lines: string[] = [];

  lines.push(`## ${emoji} Heimdall Diagnosis — ${severity.toUpperCase()}`);
  lines.push('');

  if (prompt) {
    lines.push(`> **Query:** ${prompt}`);
    lines.push('');
  }

  if (finding.summary) {
    lines.push('### Summary');
    lines.push(finding.summary);
    lines.push('');
  }

  if (finding.answer) {
    lines.push('### Answer');
    lines.push(finding.answer);
    lines.push('');
  }

  if (finding.causalChain && finding.causalChain.length > 0) {
    lines.push('### Causal Chain');
    for (const step of finding.causalChain) {
      lines.push(`- ${step}`);
    }
    lines.push('');
  }

  if (finding.remediationSteps && finding.remediationSteps.length > 0) {
    lines.push('### Remediation Steps');
    for (const step of finding.remediationSteps) {
      lines.push(`- ${step}`);
    }
    lines.push('');
  }

  if (finding.suggestedCommands && finding.suggestedCommands.length > 0) {
    lines.push('### Suggested Commands');
    lines.push('```');
    for (const cmd of finding.suggestedCommands) {
      lines.push(cmd);
    }
    lines.push('```');
    lines.push('');
  }

  if (finding.validityScore !== undefined) {
    lines.push(`*Validity score: ${finding.validityScore}*`);
    lines.push('');
  }

  lines.push('---');
  lines.push('*Powered by [Heimdall](https://github.com/billzhuang/heimdall) — AI-powered K8s SRE agent*');

  return lines.join('\n');
}

/**
 * Render a triage plaintext report into a GitHub job-summary Markdown document.
 * Used for triage mode where JSON is not emitted.
 */
export function renderTriageJobSummary(report: string): string {
  const lines: string[] = [];
  const severity = detectTriageSeverity(report);
  const emoji = severityEmoji(severity);

  lines.push(`## ${emoji} Heimdall Triage Report — ${severity.toUpperCase()}`);
  lines.push('');
  lines.push('<details>');
  lines.push('<summary>Full triage report</summary>');
  lines.push('');
  lines.push('```');
  lines.push(report.trimEnd());
  lines.push('```');
  lines.push('');
  lines.push('</details>');
  lines.push('');
  lines.push('---');
  lines.push('*Powered by [Heimdall](https://github.com/billzhuang/heimdall) — AI-powered K8s SRE agent*');

  return lines.join('\n');
}

/**
 * Heuristically detect the highest severity mentioned in a triage report.
 * Scans for case-insensitive severity keywords in the text.
 */
export function detectTriageSeverity(report: string): ActionSeverity {
  const lower = report.toLowerCase();
  if (/\bcritical\b/.test(lower)) return 'critical';
  if (/\bwarning\b/.test(lower))  return 'warning';
  if (/\binfo\b/.test(lower))     return 'info';
  return 'ok';
}
