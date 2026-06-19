/**
 * Pure helpers for Heimdall's one-shot JSON output mode (--json flag).
 *
 * Parses the two-section Markdown the agent always emits
 * (Thinking Summary + Answer, as defined in src/lib/instructions.ts) into a
 * stable JSON envelope that downstream tools can consume without scraping prose.
 *
 * No I/O here — all side-effectful wiring lives in src/format-json.ts.
 */

/** Structured envelope emitted when --json is passed to bin/heimdall. */
export interface OneShotFinding {
  /** High-level reasoning bullets from the agent's Thinking Summary section. */
  summary: string;
  /** Full agent answer (Markdown). */
  answer: string;
  /** Heuristic severity inferred from answer keywords. */
  severity: 'critical' | 'warning' | 'info';
  /**
   * kubectl commands extracted from the answer (fenced blocks + inline code).
   * Advisory only — Heimdall never executes them.
   */
  suggestedCommands: string[];
  /** Flue provider/model specifier, e.g. "anthropic/claude-sonnet-4-6". */
  model?: string;
}

/**
 * Parse raw agent output into a structured OneShotFinding.
 *
 * The agent always emits:
 *
 *   Thinking Summary:
 *   - bullet …
 *
 *   Answer:
 *   <full Markdown response>
 *
 * Headers may optionally carry a Markdown prefix (`## `).  When a section is
 * absent the parser falls back gracefully: summary → "", answer → full raw text.
 *
 * @param raw   The complete stdout captured from `flue connect heimdall local`.
 * @param model Optional Flue model specifier to embed in the envelope.
 */
export function parseOneShotOutput(raw: string, model?: string): OneShotFinding {
  // Both plain ("Thinking Summary:") and Markdown-heading ("## Thinking Summary:")
  // forms are accepted, case-insensitively.
  const summaryMatch = /(?:^|\n)(?:##?\s*)?Thinking Summary:?\s*\n/i.exec(raw);
  const answerMatch = /(?:^|\n)(?:##?\s*)?Answer:?\s*\n/i.exec(raw);

  let summary = '';
  let answer = raw.trim();

  if (summaryMatch !== null) {
    const bodyStart = summaryMatch.index + summaryMatch[0].length;
    const bodyEnd = answerMatch !== null ? answerMatch.index : raw.length;
    summary = raw.slice(bodyStart, bodyEnd).trim();
  }

  if (answerMatch !== null) {
    answer = raw.slice(answerMatch.index + answerMatch[0].length).trim();
  }

  const suggestedCommands = extractKubectlCommands(answer);
  const severity = inferSeverity(answer);

  const finding: OneShotFinding = { summary, answer, severity, suggestedCommands };
  if (model !== undefined && model !== '') finding.model = model;
  return finding;
}

/**
 * Extract `kubectl …` commands from Markdown text.
 *
 * Searches fenced code blocks (```bash / ```sh / ```shell / plain ```) first,
 * then inline backtick spans.  Deduplicates while preserving first-seen order.
 */
export function extractKubectlCommands(text: string): string[] {
  const seen = new Set<string>();
  const commands: string[] = [];

  const add = (line: string) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('kubectl ') && !seen.has(trimmed)) {
      seen.add(trimmed);
      commands.push(trimmed);
    }
  };

  // Fenced blocks: ```[lang]\n…\n```
  const fencedRe = /```(?:bash|sh|shell)?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fencedRe.exec(text)) !== null) {
    for (const line of m[1].split('\n')) add(line);
  }

  // Inline spans: `kubectl …`
  const inlineRe = /`(kubectl [^`\n]+)`/g;
  while ((m = inlineRe.exec(text)) !== null) add(m[1]);

  return commands;
}

/**
 * Infer a severity level from answer text using keyword matching.
 *
 * Defaults to "info" when no signal keywords are present.
 */
export function inferSeverity(text: string): 'critical' | 'warning' | 'info' {
  const lower = text.toLowerCase();
  if (/\b(critical|outage|unavailable)\b/.test(lower)) return 'critical';
  if (/\b(warning|degraded|oomkilled?|crashloop|backoff|failed|failing|error)\b/.test(lower)) {
    return 'warning';
  }
  return 'info';
}
