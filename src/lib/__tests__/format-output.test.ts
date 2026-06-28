import { describe, it, expect } from 'vitest';
import {
  parseOneShotOutput,
  extractKubectlCommands,
  inferSeverity,
  parseBulletList,
  parseEvidenceMap,
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

  it('uses raw.length as bodyEnd when Thinking Summary present but Answer absent', () => {
    // Exercises the false branch of the ternary at line 125.
    const raw = `Thinking Summary:\n- step one\n`;
    const result = parseOneShotOutput(raw);
    expect(result.summary).toBe('- step one');
    // No Answer: section → answer stays as raw.trim()
    expect(result.answer).toBe('Thinking Summary:\n- step one');
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

  it('does not extract commands from non-bash fenced blocks (yaml, python, etc.)', () => {
    const text = '```yaml\nkubectl get pods -n prod\n```\n```python\nkubectl version\n```';
    expect(extractKubectlCommands(text)).toEqual([]);
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

  it('flushes a trailing continuation when the last line ends with backslash', () => {
    // The block ends mid-continuation — the partial command is still emitted.
    const text = '```bash\nkubectl get pods \\\n  -n prod \\\n```';
    expect(extractKubectlCommands(text)).toEqual(['kubectl get pods -n prod']);
  });

  it('flushes pending continuation when closing fence follows immediately after backslash (no trailing newline)', () => {
    // No trailing \n before ```, so the split yields no empty last element.
    // The post-loop guard at extractCommandsFromLines is the only flush path.
    const text = '```bash\nkubectl get pods \\\n  -n prod \\```';
    expect(extractKubectlCommands(text)).toEqual(['kubectl get pods -n prod']);
  });

  it('handles a four-line continuation chain', () => {
    const text = [
      '```bash',
      'kubectl get pods \\',
      '  -n prod \\',
      '  -l app=api \\',
      '  --field-selector status.phase=Running',
      '```',
    ].join('\n');
    expect(extractKubectlCommands(text)).toEqual([
      'kubectl get pods -n prod -l app=api --field-selector status.phase=Running',
    ]);
  });

  it('extracts multiple independent commands from the same fenced block', () => {
    const text = [
      '```bash',
      'kubectl get nodes',
      'kubectl get pods -A',
      'kubectl describe node worker-1',
      '```',
    ].join('\n');
    expect(extractKubectlCommands(text)).toEqual([
      'kubectl get nodes',
      'kubectl get pods -A',
      'kubectl describe node worker-1',
    ]);
  });

  it('collects commands across multiple fenced blocks in document order', () => {
    // Fenced blocks are searched before inline spans; inline spans are appended after
    // all fenced blocks regardless of their position in the document.
    const text = [
      '```bash',
      'kubectl get nodes',
      '```',
      'Some prose with `kubectl version --client` inline.',
      '```sh',
      'kubectl get pods -A',
      '```',
    ].join('\n');
    expect(extractKubectlCommands(text)).toEqual([
      'kubectl get nodes',
      'kubectl get pods -A',
      'kubectl version --client',
    ]);
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

  it('returns "info" for an empty string', () => {
    expect(inferSeverity('')).toBe('info');
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

  it('returns "info" for "no oomkilled" (negation suppresses false positive)', () => {
    expect(inferSeverity('No OOMKilled containers detected in the last 24h.')).toBe('info');
  });

  it('returns "info" for "no crashloopbackoff" (negation suppresses false positive)', () => {
    expect(inferSeverity('All pods healthy, no CrashLoopBackOff events.')).toBe('info');
  });

  it('returns "info" for "no degraded" (negation suppresses false positive)', () => {
    expect(inferSeverity('Deployment is healthy — no degraded replicas.')).toBe('info');
  });

  it('returns "warning" for text containing "failing"', () => {
    expect(inferSeverity('The liveness probe is failing.')).toBe('warning');
  });

  it('returns "warning" for text containing "failure"', () => {
    expect(inferSeverity('Deployment failure detected.')).toBe('warning');
  });

  it('returns "warning" for text containing "failures"', () => {
    expect(inferSeverity('Multiple pod failures in the last hour.')).toBe('warning');
  });

  it('returns "warning" for text containing "fails"', () => {
    expect(inferSeverity('The readiness probe fails on every attempt.')).toBe('warning');
  });

  it('returns "info" for "no failures" (negation suppresses false positive)', () => {
    expect(inferSeverity('All checks passed with no failures.')).toBe('info');
  });

  it('returns "info" for "no failure" (negation suppresses false positive)', () => {
    expect(inferSeverity('Deployment completed with no failure.')).toBe('info');
  });

  it('prioritises "critical" over "warning" keywords when both are present', () => {
    expect(inferSeverity('Critical outage causing errors and failures.')).toBe('critical');
  });

  it('is case-insensitive', () => {
    expect(inferSeverity('CRITICAL issue detected.')).toBe('critical');
    expect(inferSeverity('WARNING: degraded performance.')).toBe('warning');
  });

  it('returns "info" for "no outage detected" (negation suppresses critical false positive)', () => {
    expect(inferSeverity('All services healthy. No outage detected in the last 24h.')).toBe('info');
  });

  it('returns "info" for "no unavailable pods" (negation suppresses critical false positive)', () => {
    expect(inferSeverity('Deployment stable. No unavailable pods found.')).toBe('info');
  });

  it('returns "info" for "no critical issues" (negation suppresses critical false positive)', () => {
    expect(inferSeverity('Health check passed. No critical issues found.')).toBe('info');
  });

  it('returns "info" for "without outage" (without-negation suppresses critical false positive)', () => {
    expect(inferSeverity('Maintenance completed without outage.')).toBe('info');
  });

  it('still returns "critical" for a real outage (not negated)', () => {
    expect(inferSeverity('Active outage affecting 3 services.')).toBe('critical');
  });

  it('still returns "critical" for unavailable (not negated)', () => {
    expect(inferSeverity('The api service has been unavailable for 30 minutes.')).toBe('critical');
  });

  it('returns "critical" when a real critical signal co-exists with a negated one', () => {
    // "no outage in region-2" is negated, but "unavailable" is not
    expect(inferSeverity('No outage in region-2, but the api is unavailable in region-1.')).toBe('critical');
  });

  it('returns "critical" when "critical" appears as a standalone positive signal', () => {
    // "no outage" is negated but "critical" is not — the critical keyword should still fire
    expect(inferSeverity('No outage detected, but this is a critical memory pressure event.')).toBe('critical');
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

  it('omits causalChain when Causal Chain section body has only empty bullet markers', () => {
    // parseBulletList("- ".trim() = "-") returns [] → false branch of items.length > 0.
    const raw = `Answer:\nok\n\nCausal Chain:\n- \n`;
    const result = parseOneShotOutput(raw);
    expect(result.causalChain).toBeUndefined();
  });

  it('omits remediationSteps when Remediation Steps section body has only empty bullet markers', () => {
    const raw = `Answer:\nok\n\nRemediation Steps:\n- \n`;
    const result = parseOneShotOutput(raw);
    expect(result.remediationSteps).toBeUndefined();
  });

  it('returns null from extractRcaSection when section body is empty (adjacent RCA headers)', () => {
    // Causal Chain header is immediately followed by Evidence header → body is empty.
    // extractRcaSection reaches the "".trim() || null path (right-hand side).
    const raw = `Answer:\nok\n\nCausal Chain:\nEvidence:\n- key: value\n`;
    const result = parseOneShotOutput(raw);
    expect(result.causalChain).toBeUndefined();
    expect(result.evidence).toEqual({ key: 'value' });
  });

  it('omits evidence entries where value is empty', () => {
    // Exercises the false branch of "if (key && value)" in parseEvidenceMap.
    const raw = `Answer:\nok\n\nEvidence:\n- empty-value: \n- good: works\n`;
    const result = parseOneShotOutput(raw);
    expect(result.evidence).toEqual({ good: 'works' });
  });

  it('extracts RCA sections when Answer section is absent (else branch + firstRca non-null)', () => {
    // No Answer: in raw → else block; Causal Chain is an RCA header → firstRca non-null.
    const raw = `Causal Chain:\n- memory leak in api\n`;
    const result = parseOneShotOutput(raw);
    expect(result.causalChain).toEqual(['memory leak in api']);
  });
});

// ---------------------------------------------------------------------------
// parseBulletList
// ---------------------------------------------------------------------------

describe('parseBulletList', () => {
  it('strips leading dash bullets', () => {
    expect(parseBulletList('- step one\n- step two')).toEqual(['step one', 'step two']);
  });

  it('strips leading asterisk bullets', () => {
    expect(parseBulletList('* first\n* second')).toEqual(['first', 'second']);
  });

  it('strips leading numbered list markers (period)', () => {
    expect(parseBulletList('1. first item\n2. second item')).toEqual(['first item', 'second item']);
  });

  it('strips leading numbered list markers (parenthesis)', () => {
    expect(parseBulletList('1) first\n2) second')).toEqual(['first', 'second']);
  });

  it('strips leading numbered list markers (colon)', () => {
    expect(parseBulletList('1: first\n2: second')).toEqual(['first', 'second']);
  });

  it('filters out blank lines', () => {
    expect(parseBulletList('- a\n\n- b\n\n')).toEqual(['a', 'b']);
  });

  it('returns empty array for an empty string', () => {
    expect(parseBulletList('')).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(parseBulletList('   \n  \n')).toEqual([]);
  });

  it('handles lines with no bullet marker', () => {
    expect(parseBulletList('plain text\nanother line')).toEqual(['plain text', 'another line']);
  });

  it('trims surrounding whitespace from each item', () => {
    expect(parseBulletList('  -  padded item  ')).toEqual(['padded item']);
  });

  it('handles mixed bullet styles in the same body', () => {
    const body = '- dash\n* asterisk\n1. numbered\n• bullet';
    expect(parseBulletList(body)).toEqual(['dash', 'asterisk', 'numbered', 'bullet']);
  });

  it('discards lines that are empty after stripping the bullet marker', () => {
    // "- " → stripped → "" → filtered out
    expect(parseBulletList('- \n- actual item')).toEqual(['actual item']);
  });
});

// ---------------------------------------------------------------------------
// parseEvidenceMap
// ---------------------------------------------------------------------------

describe('parseEvidenceMap', () => {
  it('parses a single key: value pair', () => {
    expect(parseEvidenceMap('- pod status: OOMKilled')).toEqual({ 'pod status': 'OOMKilled' });
  });

  it('parses multiple key: value pairs', () => {
    const body = '- OOMKilled pods: kubectl describe pod → exit 137\n- memory limit: 256Mi';
    expect(parseEvidenceMap(body)).toEqual({
      'OOMKilled pods': 'kubectl describe pod → exit 137',
      'memory limit': '256Mi',
    });
  });

  it('uses the first ": " as the separator, leaving later colons in the value', () => {
    // "high memory: limits.memory: 256Mi" → key="high memory", value="limits.memory: 256Mi"
    expect(parseEvidenceMap('- high memory: limits.memory: 256Mi')).toEqual({
      'high memory': 'limits.memory: 256Mi',
    });
  });

  it('returns null for an empty string', () => {
    expect(parseEvidenceMap('')).toBeNull();
  });

  it('returns null when no line has a ": " separator', () => {
    expect(parseEvidenceMap('no separator here\nanother line without one')).toBeNull();
  });

  it('skips lines where the separator is at position 0 (empty key)', () => {
    // ": value" → sep = 0 → sep <= 0 → skipped
    expect(parseEvidenceMap(': value only')).toBeNull();
  });

  it('skips lines where the value after the separator is empty', () => {
    expect(parseEvidenceMap('- key: ')).toBeNull();
  });

  it('parses numbered-list evidence lines', () => {
    const body = '1. pod phase: Pending\n2. node status: NotReady';
    expect(parseEvidenceMap(body)).toEqual({
      'pod phase': 'Pending',
      'node status': 'NotReady',
    });
  });

  it('skips blank lines silently', () => {
    const body = '- key one: value one\n\n- key two: value two';
    expect(parseEvidenceMap(body)).toEqual({ 'key one': 'value one', 'key two': 'value two' });
  });

  it('returns only valid pairs when some lines lack a separator', () => {
    const body = '- valid: entry\nno separator\n- another: one';
    expect(parseEvidenceMap(body)).toEqual({ valid: 'entry', another: 'one' });
  });
});
