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

// ── Private rendering helpers ────────────────────────────────────────────────

/** Append a named text section (header + content + blank line). No-op when content is falsy. */
function pushTextSection(lines: string[], title: string, content: string | undefined): void {
  if (!content) return;
  lines.push(`### ${title}`);
  lines.push(content);
  lines.push('');
}

/** Append a named bullet-list section (header + `- item` lines + blank line). No-op when items is empty, null, or undefined. */
function pushBulletSection(lines: string[], title: string, items: string[] | null | undefined): void {
  if (items == null || items.length === 0) return;
  lines.push(`### ${title}`);
  for (const item of items) lines.push(`- ${item}`);
  lines.push('');
}

/** Append the Heimdall branding footer (`---` + attribution line). */
function pushFooter(lines: string[]): void {
  lines.push('---');
  lines.push('*Powered by [Heimdall](https://github.com/billzhuang/heimdall) — AI-powered K8s SRE agent*');
}

// ── Public render functions ───────────────────────────────────────────────────

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

  pushTextSection(lines, 'Summary', finding.summary);
  pushTextSection(lines, 'Answer', finding.answer);
  pushBulletSection(lines, 'Causal Chain', finding.causalChain);
  pushBulletSection(lines, 'Remediation Steps', finding.remediationSteps);

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

  pushFooter(lines);

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
  pushFooter(lines);

  return lines.join('\n');
}

/**
 * Heuristically detect the highest severity mentioned in a triage report.
 *
 * Matches only when the keyword appears at the start of a line (optionally
 * preceded by whitespace) followed by a non-alphanumeric, non-hyphen character
 * or end-of-string, so hyphenated service names like "critical-api-service"
 * are not false-positive matches.
 */
export function detectTriageSeverity(report: string): ActionSeverity {
  const lower = report.toLowerCase();
  // Allow the keyword to be followed by whitespace, colon, comma, period, or EOL —
  // but NOT a hyphen or alphanumeric (which would indicate a compound identifier).
  if (/(?:^|\n)\s*critical(?=[:\s,.]|$)/.test(lower)) return 'critical';
  if (/(?:^|\n)\s*warning(?=[:\s,.]|$)/.test(lower))  return 'warning';
  if (/(?:^|\n)\s*info(?=[:\s,.]|$)/.test(lower))     return 'info';
  return 'ok';
}

/**
 * All valid literal values accepted by the `fail-on-severity` action input.
 * `satisfies` enforces that every entry is a valid ActionSeverity — the
 * compiler rejects any element that does not appear in the union.
 */
export const VALID_FAIL_ON_SEVERITIES = [
  'critical', 'warning', 'info', 'ok',
] as const satisfies readonly ActionSeverity[];

const VALID_FAIL_ON_SET: ReadonlySet<string> = new Set(VALID_FAIL_ON_SEVERITIES);

export type FailOnDecision =
  | { ok: true }
  | { ok: false; reason: 'invalid-value'; value: string }
  | { ok: false; reason: 'threshold-met'; found: ActionSeverity; threshold: ActionSeverity };

/**
 * Pure helper that decides whether a GitHub Action should fail given a
 * `failOn` threshold string and the detected `found` severity.
 *
 * Returns `{ ok: true }` when no failure is warranted, or a discriminated
 * union describing _why_ the action should fail so the caller can emit the
 * appropriate message and exit.
 */
export function evaluateFailOn(failOn: string, found: ActionSeverity): FailOnDecision {
  const lower = failOn.trim().toLowerCase();
  if (!lower) return { ok: true };
  if (!VALID_FAIL_ON_SET.has(lower)) {
    return { ok: false, reason: 'invalid-value', value: failOn };
  }
  return severityAtLeast(found, lower as ActionSeverity)
    ? { ok: false, reason: 'threshold-met', found, threshold: lower as ActionSeverity }
    : { ok: true };
}
