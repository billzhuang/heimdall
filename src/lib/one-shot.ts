/**
 * Pure helpers for Heimdall's machine-readable one-shot JSON output.
 *
 * The agent always responds in the "Thinking Summary" + "Answer" two-section
 * format (src/lib/instructions.ts).  These helpers parse that text into a
 * structured envelope and enrich it with derived fields (severity, suggested
 * commands) so downstream pipelines can consume it without text-scraping.
 */

/** A machine-readable one-shot diagnosis result. */
export interface OneShotResult {
  /** Thinking Summary bullets (empty array when the section is absent). */
  summary: string[];
  /** The full Answer section text. */
  answer: string;
  /** Severity derived from the answer text via keyword heuristics. */
  severity: 'critical' | 'warning' | 'info' | 'healthy';
  /** kubectl commands extracted from the answer — advisory only, never executed. */
  suggestedCommands: string[];
  /** Model specifier used to produce the response (e.g. anthropic/claude-sonnet-4-6). */
  model: string;
}

/**
 * Parse the two-section agent response into a structured OneShotResult.
 *
 * Expected agent format:
 *   Thinking Summary:
 *   - bullet 1
 *   - bullet 2
 *
 *   Answer:
 *   <full response text>
 *
 * Falls back gracefully: if the "Answer:" header is absent the whole text
 * becomes the answer; if there are no bullets the summary is an empty array.
 */
export function parseAgentResponse(text: string, model: string): OneShotResult {
  // Split on "Answer:" header — the agent always emits it on its own line.
  const answerHeader = /\nAnswer:\s*\n/.exec(text);

  let summaryText = '';
  let answer = text.trim();

  if (answerHeader) {
    summaryText = text.slice(0, answerHeader.index);
    answer = text.slice(answerHeader.index + answerHeader[0].length).trim();
  }

  const summary = summaryText
    .split('\n')
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter((line) => line && !/^thinking summary/i.test(line));

  return {
    summary,
    answer,
    severity: deriveSeverity(answer),
    suggestedCommands: extractSuggestedCommands(text),
    model,
  };
}

const CRITICAL_RE =
  /\b(critical|crash(?:loop)?|oom.?kill|evict|not running|failed|error|down\b|unavailable|image.*pull.*back)/i;
const WARNING_RE =
  /\b(warn(?:ing)?|degraded|slow|high.latency|pending|restarting|throttl|limited|high memory|high cpu)/i;
const HEALTHY_RE = /\b(healthy|all.*running|all.*ready|no issues|no problems|looks good|all good)/i;

/**
 * Derive a severity level from the answer text using keyword heuristics.
 *
 * Priority order: critical > warning > healthy > info (default).
 */
export function deriveSeverity(text: string): 'critical' | 'warning' | 'info' | 'healthy' {
  if (CRITICAL_RE.test(text)) return 'critical';
  if (WARNING_RE.test(text)) return 'warning';
  if (HEALTHY_RE.test(text)) return 'healthy';
  return 'info';
}

/**
 * Extract kubectl commands from code blocks and inline code in the text.
 *
 * Searches fenced blocks (```bash / ```sh / ```shell / ``` kubectl) first,
 * then inline backtick spans.  Preserves order and deduplicates.
 * Returns advisory suggestions only — Heimdall never executes them.
 */
export function extractSuggestedCommands(text: string): string[] {
  const seen = new Set<string>();
  const commands: string[] = [];

  const add = (cmd: string) => {
    const trimmed = cmd.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      commands.push(trimmed);
    }
  };

  // Fenced code blocks: ```[lang]\n...\n```
  const fenced = /```(?:bash|sh|shell|kubectl)?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenced.exec(text)) !== null) {
    for (const line of m[1].split('\n')) {
      if (line.trimStart().startsWith('kubectl')) add(line);
    }
  }

  // Inline code: `kubectl ...`
  const inline = /`(kubectl[^`\n]+)`/g;
  while ((m = inline.exec(text)) !== null) {
    add(m[1]);
  }

  return commands;
}
