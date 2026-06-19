import { describe, it, expect } from 'vitest';
import {
  parseOneShotOutput,
  extractKubectlCommands,
  inferSeverity,
  type OneShotFinding,
} from '../format-output.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_OUTPUT = `Thinking Summary:
- Checked the api deployment in prod
- Found 0/2 replicas available; rollout stuck
- Recent events show ImagePullBackOff on the new pods
- Root cause: invalid image tag pushed in the last deploy

Answer:
The \`api\` deployment in the \`prod\` namespace is failing because the image tag
\`v2.3.1-rc\` does not exist in the registry.

To remediate:

\`\`\`bash
kubectl rollout undo deploy/api -n prod
kubectl describe pod -l app=api -n prod
\`\`\`

You can also inspect events with \`kubectl get events -n prod --sort-by='.lastTimestamp'\`.
`;

const MARKDOWN_HEADINGS_OUTPUT = `## Thinking Summary:
- Looked at namespace default
- All pods healthy

## Answer:
Everything looks fine. No warning events in the last hour.
`;

// ---------------------------------------------------------------------------
// parseOneShotOutput — section extraction
// ---------------------------------------------------------------------------

describe('parseOneShotOutput', () => {
  it('extracts summary and answer from a well-formed two-section response', () => {
    const result = parseOneShotOutput(FULL_OUTPUT);

    expect(result.summary).toContain('Checked the api deployment in prod');
    expect(result.summary).toContain('Root cause: invalid image tag');
    expect(result.answer).toContain('image tag');
    expect(result.answer).toContain('kubectl rollout undo');
    // summary must not bleed into the answer
    expect(result.summary).not.toContain('Answer:');
  });

  it('extracts sections when headers carry Markdown ## prefix', () => {
    const result = parseOneShotOutput(MARKDOWN_HEADINGS_OUTPUT);

    expect(result.summary).toContain('Looked at namespace default');
    expect(result.answer).toContain('Everything looks fine');
  });

  it('falls back to raw text as answer when Answer: section is absent', () => {
    const raw = 'The cluster looks healthy.';
    const result = parseOneShotOutput(raw);

    expect(result.answer).toBe('The cluster looks healthy.');
    expect(result.summary).toBe('');
  });

  it('returns empty summary when Thinking Summary: section is absent', () => {
    const raw = `Answer:\nAll pods are running.\n`;
    const result = parseOneShotOutput(raw);

    expect(result.summary).toBe('');
    expect(result.answer).toBe('All pods are running.');
  });

  it('trims leading/trailing whitespace from both sections', () => {
    const raw = `Thinking Summary:\n  - bullet\n\nAnswer:\n  body text  \n`;
    const result = parseOneShotOutput(raw);

    expect(result.summary).toBe('- bullet');
    expect(result.answer).toBe('body text');
  });

  it('embeds model when provided', () => {
    const result = parseOneShotOutput('Answer:\nok\n', 'anthropic/claude-sonnet-4-6');
    expect(result.model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('omits model key when model is undefined', () => {
    const result = parseOneShotOutput('Answer:\nok\n');
    expect('model' in result).toBe(false);
  });

  it('omits model key when model is empty string', () => {
    const result = parseOneShotOutput('Answer:\nok\n', '');
    expect('model' in result).toBe(false);
  });

  it('is case-insensitive for section headers', () => {
    const raw = `thinking summary:\n- note\n\nanswer:\nthe answer\n`;
    const result = parseOneShotOutput(raw);

    expect(result.summary).toBe('- note');
    expect(result.answer).toBe('the answer');
  });

  it('handles an empty string without throwing', () => {
    const result = parseOneShotOutput('');
    const expected: OneShotFinding = {
      summary: '',
      answer: '',
      severity: 'info',
      suggestedCommands: [],
    };
    expect(result).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// extractKubectlCommands
// ---------------------------------------------------------------------------

describe('extractKubectlCommands', () => {
  it('extracts kubectl commands from a fenced bash block', () => {
    const text = '```bash\nkubectl get pods -n prod\nkubectl describe node worker-1\n```';
    expect(extractKubectlCommands(text)).toEqual([
      'kubectl get pods -n prod',
      'kubectl describe node worker-1',
    ]);
  });

  it('extracts from plain fenced blocks (no language specifier)', () => {
    const text = '```\nkubectl get nodes\n```';
    expect(extractKubectlCommands(text)).toEqual(['kubectl get nodes']);
  });

  it('extracts from sh and shell fenced blocks', () => {
    const sh = '```sh\nkubectl version\n```';
    const shell = '```shell\nkubectl cluster-info\n```';
    expect(extractKubectlCommands(sh)).toEqual(['kubectl version']);
    expect(extractKubectlCommands(shell)).toEqual(['kubectl cluster-info']);
  });

  it('extracts kubectl commands from inline code spans', () => {
    const text = 'Run `kubectl get events -n prod` to see recent events.';
    expect(extractKubectlCommands(text)).toEqual(['kubectl get events -n prod']);
  });

  it('deduplicates commands preserving first-seen order', () => {
    const text = [
      '```bash',
      'kubectl get pods -n prod',
      'kubectl get pods -n prod',
      '```',
      'Also run `kubectl get pods -n prod`.',
    ].join('\n');
    expect(extractKubectlCommands(text)).toEqual(['kubectl get pods -n prod']);
  });

  it('prefers fenced block commands over inline duplicates (order)', () => {
    const text = [
      'Try `kubectl describe pod web -n prod`.',
      '```bash',
      'kubectl describe pod web -n prod',
      'kubectl logs web -n prod',
      '```',
    ].join('\n');
    // Inline appears first in the text but fenced blocks are searched first.
    const cmds = extractKubectlCommands(text);
    expect(cmds[0]).toBe('kubectl describe pod web -n prod');
    expect(cmds[1]).toBe('kubectl logs web -n prod');
    expect(cmds).toHaveLength(2);
  });

  it('ignores non-kubectl lines inside fenced blocks', () => {
    const text = '```bash\necho hello\nkubectl get nodes\n./script.sh\n```';
    expect(extractKubectlCommands(text)).toEqual(['kubectl get nodes']);
  });

  it('extracts multi-line kubectl commands with backslash continuations', () => {
    const text = '```bash\nkubectl get pods \\\n  -n prod \\\n  -l app=api\n```';
    expect(extractKubectlCommands(text)).toEqual([
      'kubectl get pods -n prod -l app=api',
    ]);
  });

  it('returns empty array when no kubectl commands are present', () => {
    expect(extractKubectlCommands('No commands here.')).toEqual([]);
  });

  it('uses commands from the full fixture correctly', () => {
    const result = parseOneShotOutput(FULL_OUTPUT);
    expect(result.suggestedCommands).toContain('kubectl rollout undo deploy/api -n prod');
    expect(result.suggestedCommands).toContain('kubectl describe pod -l app=api -n prod');
    expect(result.suggestedCommands).toContain(
      "kubectl get events -n prod --sort-by='.lastTimestamp'",
    );
  });
});

// ---------------------------------------------------------------------------
// inferSeverity
// ---------------------------------------------------------------------------

describe('inferSeverity', () => {
  it('returns "critical" for text containing "critical"', () => {
    expect(inferSeverity('This is a critical failure.')).toBe('critical');
  });

  it('returns "critical" for text containing "outage"', () => {
    expect(inferSeverity('The cluster is experiencing an outage.')).toBe('critical');
  });

  it('returns "critical" for text containing "unavailable"', () => {
    expect(inferSeverity('The service is unavailable.')).toBe('critical');
  });

  it('returns "warning" for text containing "warning"', () => {
    expect(inferSeverity('A warning event was received.')).toBe('warning');
  });

  it('returns "warning" for text containing "oomkill"', () => {
    expect(inferSeverity('The container was OOMKilled due to high memory use.')).toBe('warning');
  });

  it('returns "warning" for text containing "crashloop"', () => {
    expect(inferSeverity('The pod is in a CrashLoop.')).toBe('warning');
  });

  it('returns "warning" for text containing "CrashLoopBackOff"', () => {
    expect(inferSeverity('Pod api-7f9b is in CrashLoopBackOff status.')).toBe('warning');
  });

  it('returns "warning" for text containing "backoff"', () => {
    expect(inferSeverity('Back-off restarting the failed container (backoff).')).toBe('warning');
  });

  it('returns "warning" for text containing "failed"', () => {
    expect(inferSeverity('The probe failed.')).toBe('warning');
  });

  it('returns "warning" for text containing "error"', () => {
    expect(inferSeverity('An error occurred during startup.')).toBe('warning');
  });

  it('returns "info" when no severity keywords are present', () => {
    expect(inferSeverity('Everything looks healthy. All pods are running.')).toBe('info');
  });

  it('returns "info" for "no warning events" (negation suppresses false positive)', () => {
    expect(inferSeverity('The cluster is healthy. No warning events in the last hour.')).toBe('info');
  });

  it('returns "info" for "no errors" (negation suppresses false positive)', () => {
    expect(inferSeverity('All checks passed. No errors detected.')).toBe('info');
  });

  it('returns "info" for "without errors"', () => {
    expect(inferSeverity('The pod started successfully without errors.')).toBe('info');
  });

  it('prioritises "critical" over "warning" keywords when both are present', () => {
    expect(inferSeverity('Critical outage causing errors and failures.')).toBe('critical');
  });

  it('is case-insensitive', () => {
    expect(inferSeverity('CRITICAL issue detected.')).toBe('critical');
    expect(inferSeverity('WARNING: degraded performance.')).toBe('warning');
  });
});

// ---------------------------------------------------------------------------
// Structured RCA fields — causalChain, evidence, validityScore, remediationSteps
// ---------------------------------------------------------------------------

const FULL_RCA_OUTPUT = `Thinking Summary:
- Checked the api deployment in prod
- Found OOMKilled containers

Answer:
The api deployment containers are being OOMKilled due to insufficient memory limits.

Causal Chain:
- Inspected deployment and found 3 OOMKilled pods
- Memory limit is 256Mi but actual usage peaks at 400Mi
- Root cause: memory limit set too low at deploy time

Evidence:
- OOMKilled pods: kubectl describe pod api-abc -n prod → "Last State: Terminated Reason: OOMKilled"
- memory limit: kubectl get deploy api -n prod -o yaml → "limits.memory: 256Mi"

Validity Score: 0.9

Remediation Steps:
1. Increase memory limit to 512Mi in the Deployment spec
2. Run kubectl rollout restart deploy/api -n prod after updating
`;

describe('structured RCA fields', () => {
  it('extracts causalChain as an array of strings', () => {
    const result = parseOneShotOutput(FULL_RCA_OUTPUT);
    expect(result.causalChain).toEqual([
      'Inspected deployment and found 3 OOMKilled pods',
      'Memory limit is 256Mi but actual usage peaks at 400Mi',
      'Root cause: memory limit set too low at deploy time',
    ]);
  });

  it('extracts evidence as a key-value map', () => {
    const result = parseOneShotOutput(FULL_RCA_OUTPUT);
    expect(result.evidence).toMatchObject({
      'OOMKilled pods': expect.stringContaining('OOMKilled'),
      'memory limit': expect.stringContaining('256Mi'),
    });
  });

  it('extracts validityScore as a number', () => {
    const result = parseOneShotOutput(FULL_RCA_OUTPUT);
    expect(result.validityScore).toBe(0.9);
  });

  it('extracts remediationSteps as an array', () => {
    const result = parseOneShotOutput(FULL_RCA_OUTPUT);
    expect(result.remediationSteps).toEqual([
      'Increase memory limit to 512Mi in the Deployment spec',
      'Run kubectl rollout restart deploy/api -n prod after updating',
    ]);
  });

  it('truncates answer before the first RCA section header', () => {
    const result = parseOneShotOutput(FULL_RCA_OUTPUT);
    expect(result.answer).not.toContain('Causal Chain');
    expect(result.answer).not.toContain('Evidence');
    expect(result.answer).not.toContain('Validity Score');
    expect(result.answer).not.toContain('Remediation Steps');
    expect(result.answer).toContain('OOMKilled due to insufficient memory');
  });

  it('omits RCA fields when sections are absent (backward compatibility)', () => {
    const result = parseOneShotOutput(FULL_OUTPUT);
    expect(result.causalChain).toBeUndefined();
    expect(result.evidence).toBeUndefined();
    expect(result.validityScore).toBeUndefined();
    expect(result.remediationSteps).toBeUndefined();
  });

  it('clamps validityScore to [0, 1] — upper bound', () => {
    const raw = `Answer:\nok\n\nValidity Score: 1.5\n`;
    expect(parseOneShotOutput(raw).validityScore).toBe(1);
  });

  it('clamps validityScore to [0, 1] — lower bound', () => {
    const raw = `Answer:\nok\n\nValidity Score: -0.5\n`;
    expect(parseOneShotOutput(raw).validityScore).toBe(0);
  });

  it('does not truncate answer on exact section name + colon inline (e.g. "Causal Chain: a brief note")', () => {
    const raw = `Answer:\nCausal Chain: a brief mention in prose.\nMore text here.\n`;
    const result = parseOneShotOutput(raw);
    expect(result.answer).toContain('Causal Chain: a brief mention in prose.');
    expect(result.answer).toContain('More text here.');
    expect(result.causalChain).toBeUndefined();
  });

  it('omits validityScore when Validity Score section is absent', () => {
    const raw = `Answer:\nok\n\nCausal Chain:\n- checked pods\n`;
    expect(parseOneShotOutput(raw).validityScore).toBeUndefined();
  });

  it('accepts Markdown ## prefix on RCA headers', () => {
    const raw = `## Thinking Summary:\n- checked pods\n\n## Answer:\nOK\n\n## Causal Chain:\n- step one\n\n## Validity Score: 0.7\n`;
    const result = parseOneShotOutput(raw);
    expect(result.causalChain).toEqual(['step one']);
    expect(result.validityScore).toBe(0.7);
  });

  it('omits evidence when map has no parseable key-value pairs', () => {
    const raw = `Answer:\nok\n\nEvidence:\nno structured evidence here\n`;
    expect(parseOneShotOutput(raw).evidence).toBeUndefined();
  });

  it('parses evidence from a numbered list (e.g. "1. finding: evidence")', () => {
    const raw = `Answer:\nok\n\nEvidence:\n1. OOMKilled pods: kubectl describe pod → exit 137\n2. high memory: limits.memory: 256Mi\n`;
    const result = parseOneShotOutput(raw);
    expect(result.evidence).toMatchObject({
      'OOMKilled pods': 'kubectl describe pod → exit 137',
      'high memory': 'limits.memory: 256Mi',
    });
  });

  it('does not truncate answer on a phrase like "Evidence points to..." (no colon/prefix)', () => {
    const raw = `Answer:\nEvidence points to a misconfigured probe.\nCausal chain analysis shows restart loops.\n`;
    const result = parseOneShotOutput(raw);
    expect(result.answer).toContain('Evidence points to');
    expect(result.answer).toContain('Causal chain analysis');
    expect(result.causalChain).toBeUndefined();
    expect(result.evidence).toBeUndefined();
  });

  it('preserves suggestedCommands from the answer section only (not RCA sections)', () => {
    const raw = `Answer:\nRun \`kubectl get pods -n prod\`.\n\nRemediation Steps:\n1. Apply the fix\n`;
    const result = parseOneShotOutput(raw);
    expect(result.suggestedCommands).toEqual(['kubectl get pods -n prod']);
  });
});
