import { describe, it, expect } from 'vitest';
import {
  parseAgentResponse,
  deriveSeverity,
  extractSuggestedCommands,
} from '../one-shot.ts';

const MODEL = 'anthropic/claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const FULL_RESPONSE = `Thinking Summary:
- Checked the pod status and event log in the prod namespace.
- Found 3 OOMKilled restarts in the last hour.
- Memory limit is set to 256 Mi but the process peaks at ~300 Mi.

Answer:
The pod \`api-server-7d9c8\` in \`prod\` is in CrashLoopBackOff due to OOMKilled restarts.

Run these to confirm:

\`\`\`bash
kubectl describe pod api-server-7d9c8 -n prod
kubectl top pod api-server-7d9c8 -n prod
\`\`\`

Increase the memory limit in the Deployment manifest to at least 512 Mi.`;

// ---------------------------------------------------------------------------
// parseAgentResponse
// ---------------------------------------------------------------------------

describe('parseAgentResponse', () => {
  it('extracts Thinking Summary bullets', () => {
    const r = parseAgentResponse(FULL_RESPONSE, MODEL);
    expect(r.summary).toHaveLength(3);
    expect(r.summary[0]).toBe('Checked the pod status and event log in the prod namespace.');
    expect(r.summary[1]).toBe('Found 3 OOMKilled restarts in the last hour.');
    expect(r.summary[2]).toContain('256 Mi');
  });

  it('extracts the Answer section', () => {
    const r = parseAgentResponse(FULL_RESPONSE, MODEL);
    expect(r.answer).toContain('CrashLoopBackOff');
    expect(r.answer).not.toContain('Thinking Summary:');
  });

  it('sets the model field', () => {
    const r = parseAgentResponse(FULL_RESPONSE, MODEL);
    expect(r.model).toBe(MODEL);
  });

  it('falls back to full text when Answer section is absent', () => {
    const r = parseAgentResponse('Just a plain response with no sections.', MODEL);
    expect(r.summary).toHaveLength(0);
    expect(r.answer).toBe('Just a plain response with no sections.');
  });

  it('handles empty string', () => {
    const r = parseAgentResponse('', MODEL);
    expect(r.summary).toHaveLength(0);
    expect(r.answer).toBe('');
  });

  it('does not include the "Thinking Summary:" header line in the bullets', () => {
    const r = parseAgentResponse(FULL_RESPONSE, MODEL);
    expect(r.summary.some((s) => /thinking summary/i.test(s))).toBe(false);
  });

  it('parses a response that starts directly with Answer: (no Thinking Summary)', () => {
    const text = 'Answer:\nThe cluster looks healthy.';
    const r = parseAgentResponse(text, MODEL);
    expect(r.summary).toHaveLength(0);
    expect(r.answer).toBe('The cluster looks healthy.');
  });
});

// ---------------------------------------------------------------------------
// deriveSeverity
// ---------------------------------------------------------------------------

describe('deriveSeverity', () => {
  it('returns critical for CrashLoopBackOff', () => {
    expect(deriveSeverity('Pod is in CrashLoopBackOff')).toBe('critical');
  });

  it('returns critical for OOMKilled', () => {
    expect(deriveSeverity('Container was OOMKilled')).toBe('critical');
  });

  it('returns critical for failed/error keywords', () => {
    expect(deriveSeverity('The deployment has failed')).toBe('critical');
    expect(deriveSeverity('ImagePullBackOff error')).toBe('critical');
  });

  it('returns warning for throttling', () => {
    expect(deriveSeverity('CPU is being throttled heavily')).toBe('warning');
  });

  it('returns warning for pending pods', () => {
    expect(deriveSeverity('Some pods are still pending')).toBe('warning');
  });

  it('returns warning for degraded', () => {
    expect(deriveSeverity('Deployment is degraded — only 1/3 replicas ready')).toBe('warning');
  });

  it('returns healthy for positive keywords', () => {
    expect(deriveSeverity('All pods are healthy and running')).toBe('healthy');
    expect(deriveSeverity('Cluster looks good, no issues found')).toBe('healthy');
  });

  it('healthy beats critical when both signals appear (e.g. summary sentence)', () => {
    // "No critical issues; all pods are healthy" — healthy keyword wins
    expect(deriveSeverity('No critical issues; all pods are healthy.')).toBe('healthy');
    expect(deriveSeverity('All nodes are ready and all good — no errors detected.')).toBe('healthy');
  });

  it('returns info as the default', () => {
    expect(deriveSeverity('The deployment has 3 replicas configured')).toBe('info');
  });

  it('does not false-positive on directly negated critical phrases', () => {
    // "no error" — lookbehind skips "error"; HEALTHY_RE matches "all.*running"
    expect(deriveSeverity('No error found, all pods are running.')).toBe('healthy');
    // "zero failed" — lookbehind skips "failed"
    expect(deriveSeverity('Zero failed jobs were detected.')).toBe('info');
    // "not error" — lookbehind skips "error"
    expect(deriveSeverity('Not error prone, the deployment is stable.')).toBe('info');
  });

  it('does not false-positive on directly negated warning phrases', () => {
    expect(deriveSeverity('No warnings detected in the namespace.')).toBe('info');
    expect(deriveSeverity('Zero pending pods remain.')).toBe('info');
  });

  it('still detects critical in un-negated contexts', () => {
    expect(deriveSeverity('Pod is in CrashLoopBackOff')).toBe('critical');
    expect(deriveSeverity('The job has failed repeatedly')).toBe('critical');
  });

  it('"not running" is critical (explicit unavailability phrase)', () => {
    // "not running" is listed explicitly in CRITICAL_RE — it means pods are down
    expect(deriveSeverity('The api service is not running')).toBe('critical');
  });
});

// ---------------------------------------------------------------------------
// extractSuggestedCommands
// ---------------------------------------------------------------------------

describe('extractSuggestedCommands', () => {
  it('extracts kubectl commands from a bash fenced block', () => {
    const text = 'Try:\n```bash\nkubectl get pods -n prod\nkubectl describe pod api -n prod\n```';
    const cmds = extractSuggestedCommands(text);
    expect(cmds).toContain('kubectl get pods -n prod');
    expect(cmds).toContain('kubectl describe pod api -n prod');
  });

  it('extracts kubectl commands from an unlabelled fenced block', () => {
    const text = '```\nkubectl top pods\n```';
    expect(extractSuggestedCommands(text)).toContain('kubectl top pods');
  });

  it('does not extract non-kubectl lines from fenced blocks', () => {
    const text = '```bash\necho hello\nkubectl get pods\n```';
    const cmds = extractSuggestedCommands(text);
    expect(cmds).not.toContain('echo hello');
    expect(cmds).toContain('kubectl get pods');
  });

  it('extracts kubectl commands from inline code', () => {
    const text = 'Run `kubectl rollout status deploy/api -n prod` to confirm.';
    expect(extractSuggestedCommands(text)).toContain('kubectl rollout status deploy/api -n prod');
  });

  it('deduplicates commands appearing in both blocks and inline', () => {
    const text =
      '```bash\nkubectl get pods\n```\n\nAlso run `kubectl get pods` again.';
    const cmds = extractSuggestedCommands(text);
    expect(cmds.filter((c) => c === 'kubectl get pods')).toHaveLength(1);
  });

  it('returns empty array when no commands present', () => {
    expect(extractSuggestedCommands('No commands here at all')).toEqual([]);
  });
});
