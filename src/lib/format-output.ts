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
  /** Ordered reasoning steps that led to the root cause (from Causal Chain section). */
  causalChain?: string[];
  /** Map from finding/claim to the kubectl or Prometheus output that supports it. */
  evidence?: Record<string, string>;
  /**
   * Confidence in the root cause: 0.0–1.0.
   * 1.0 = multiple independent tools corroborate; lower = fewer or weaker sources.
   */
  validityScore?: number;
  /** Human-readable remediation actions (from Remediation Steps section). */
  remediationSteps?: string[];
}

/**
 * Regex matching any structured RCA section header (Causal Chain, Evidence,
 * Validity Score, Remediation Steps). Used to find section boundaries.
 */
const RCA_SECTION_HEADER_RE =
  /(?:^|\n)(?:##?\s+(?:Causal Chain|Evidence|Validity Score|Remediation Steps?):?|(?:Causal Chain|Evidence|Validity Score|Remediation Steps?):)[ \t]*/im;

/**
 * Extract the body of a named section from raw output.
 * Stops at the next RCA section header or end of string.
 * Returns null when the section is absent or its body is empty.
 */
function extractRcaSection(raw: string, headerRe: RegExp): string | null {
  const m = headerRe.exec(raw);
  if (!m) return null;
  const bodyStart = m.index + m[0].length;
  const stop = RCA_SECTION_HEADER_RE.exec(raw.slice(bodyStart));
  const bodyEnd = stop !== null ? bodyStart + stop.index : raw.length;
  return raw.slice(bodyStart, bodyEnd).trim() || null;
}

/** Parse a bullet/numbered list body into an array of trimmed strings. */
function parseBulletList(body: string): string[] {
  return body
    .split('\n')
    .map(l => l.replace(/^\s*(?:[-*•]|\d+[.):])\s*/, '').trim())
    .filter(Boolean);
}

/** Parse an evidence section body into a { finding: evidence } map. */
function parseEvidenceMap(body: string): Record<string, string> | null {
  const map: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const stripped = line.replace(/^\s*(?:[-*•]|\d+[.):])\s*/, '').trim();
    const sep = stripped.indexOf(': ');
    if (sep > 0) {
      const key = stripped.slice(0, sep).trim();
      const value = stripped.slice(sep + 2).trim();
      if (key && value) map[key] = value;
    }
  }
  return Object.keys(map).length > 0 ? map : null;
}

/**
 * Parse raw agent output into a structured OneShotFinding.
 *
 * The agent emits:
 *
 *   Thinking Summary:      (bullets)
 *   Answer:                (full Markdown investigation)
 *   Causal Chain:          (bullets)
 *   Evidence:              (key: value pairs)
 *   Validity Score: <n>    (0.0–1.0 float)
 *   Remediation Steps:     (numbered list)
 *
 * All sections except Thinking Summary and Answer are optional.
 * Headers may carry a Markdown prefix (`## `); matching is case-insensitive.
 * Falls back gracefully when sections are absent.
 *
 * @param raw   The complete stdout captured from `flue connect heimdall local`.
 * @param model Optional Flue model specifier to embed in the envelope.
 */
export function parseOneShotOutput(raw: string, model?: string): OneShotFinding {
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
    const bodyStart = answerMatch.index + answerMatch[0].length;
    // Truncate the answer before the first RCA section header.
    const firstRca = RCA_SECTION_HEADER_RE.exec(raw.slice(bodyStart));
    const bodyEnd = firstRca !== null ? bodyStart + firstRca.index : raw.length;
    answer = raw.slice(bodyStart, bodyEnd).trim();
  }

  const suggestedCommands = extractKubectlCommands(answer);
  const severity = inferSeverity(answer);

  const finding: OneShotFinding = { summary, answer, severity, suggestedCommands };
  if (model !== undefined && model !== '') finding.model = model;

  // ── Structured RCA fields ────────────────────────────────────────────────

  const causalBody = extractRcaSection(raw, /(?:^|\n)(?:##?\s+Causal Chain:?|Causal Chain:)[ \t]*\n/i);
  if (causalBody) {
    const items = parseBulletList(causalBody);
    if (items.length > 0) finding.causalChain = items;
  }

  const evidenceBody = extractRcaSection(raw, /(?:^|\n)(?:##?\s+Evidence:?|Evidence:)[ \t]*\n/i);
  if (evidenceBody) {
    const map = parseEvidenceMap(evidenceBody);
    if (map) finding.evidence = map;
  }

  const vsMatch = /(?:^|\n)(?:##?\s+Validity Score:?|Validity Score:)[ \t]*(\d+(?:\.\d+)?)/i.exec(raw);
  if (vsMatch) {
    const score = parseFloat(vsMatch[1]);
    if (!isNaN(score)) finding.validityScore = Math.min(1, Math.max(0, score));
  }

  const remBody = extractRcaSection(raw, /(?:^|\n)(?:##?\s+Remediation Steps?:?|Remediation Steps?:)[ \t]*\n/i);
  if (remBody) {
    const items = parseBulletList(remBody);
    if (items.length > 0) finding.remediationSteps = items;
  }

  return finding;
}

/**
 * Extract `kubectl …` commands from Markdown text.
 *
 * Searches fenced code blocks (```bash / ```sh / ```shell / plain ```) first,
 * then inline backtick spans.  Deduplicates while preserving first-seen order.
 *
 * Handles backslash line continuations inside fenced blocks:
 *   kubectl get pods \
 *     -n prod \
 *     -l app=api
 * is yielded as a single command "kubectl get pods -n prod -l app=api".
 */
export function extractKubectlCommands(text: string): string[] {
  const seen = new Set<string>();
  const commands: string[] = [];

  const add = (cmd: string) => {
    const trimmed = cmd.trim();
    if (trimmed.startsWith('kubectl ') && !seen.has(trimmed)) {
      seen.add(trimmed);
      commands.push(trimmed);
    }
  };

  // Fenced blocks: ```[lang]\n…\n```
  const fencedRe = /```(?:bash|sh|shell)?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fencedRe.exec(text)) !== null) {
    const lines = m[1].split('\n');
    let current = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (current !== '') {
        // Continuation: append this fragment (strip the trailing backslash if present)
        if (trimmed.endsWith('\\')) {
          current += ' ' + trimmed.slice(0, -1).trim();
        } else {
          add(current + ' ' + trimmed);
          current = '';
        }
      } else if (trimmed.startsWith('kubectl ')) {
        if (trimmed.endsWith('\\')) {
          current = trimmed.slice(0, -1).trim();
        } else {
          add(trimmed);
        }
      }
    }
    // Flush a trailing continuation (no final non-backslash line).
    if (current !== '') add(current);
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
  // Suppress false positives from healthy summaries like "no warning events" / "no errors".
  if (/\b(?:no|without)\s+(?:warnings?|errors?|fail(?:ed|ing)?|degraded|back-?off|crashloop(?:backoff)?|oomkilled?)\b/.test(lower)) {
    return 'info';
  }
  if (/\b(warning|degraded|oomkilled?|crashloop(backoff)?|back-?off|failed|failing|error)\b/.test(lower)) {
    return 'warning';
  }
  return 'info';
}
