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
  /(?:^|\n)(?:##?\s+(?:Causal Chain|Evidence|Validity Score|Remediation Steps?):?|(?:Causal Chain|Evidence|Validity Score|Remediation Steps?):)[ \t]*(?=\n|-?\d)/im;

function makeSectionRe(sectionPattern: string, suffix: string): RegExp {
  return new RegExp(`(?:^|\\n)(?:##?\\s+${sectionPattern}:?|${sectionPattern}:)[ \\t]*${suffix}`, 'i');
}

/** Header regex for each named RCA section. */
const CAUSAL_CHAIN_RE = makeSectionRe('Causal Chain', '\\n');
const EVIDENCE_RE = makeSectionRe('Evidence', '\\n');
const VALIDITY_SCORE_RE = makeSectionRe('Validity Score', '(-?\\d+(?:\\.\\d+)?)');
const REMEDIATION_STEPS_RE = makeSectionRe('Remediation Steps?', '\\n');

/** Strips leading bullet or numbered-list markers from a line. */
const BULLET_STRIP_RE = /^\s*(?:[-*•]|\d+[.):])\s*/;

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
export function parseBulletList(body: string): string[] {
  return body
    .split('\n')
    .map(l => l.replace(BULLET_STRIP_RE, '').trim())
    .filter(Boolean);
}

/**
 * Parse an evidence section body into a `{ finding: evidence }` map.
 *
 * Each line must be a `key: value` pair (the first `: ` is the separator).
 * Lines without a separator, or where key or value is empty after trimming,
 * are skipped. Returns `null` when no valid pairs are found.
 */
export function parseEvidenceMap(body: string): Record<string, string> | null {
  const map: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const stripped = line.replace(BULLET_STRIP_RE, '').trim();
    const sep = stripped.indexOf(': ');
    if (sep <= 0) continue;
    const key = stripped.slice(0, sep).trim();
    const value = stripped.slice(sep + 2).trim();
    map[key] = value;
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
  // rcaRaw: slice of raw starting at the first RCA section header, so extractors
  // never accidentally match section-like phrases inside the Answer body.
  let rcaRaw = '';

  if (summaryMatch !== null) {
    const bodyStart = summaryMatch.index + summaryMatch[0].length;
    const bodyEnd = answerMatch !== null ? answerMatch.index : raw.length;
    summary = raw.slice(bodyStart, bodyEnd).trim();
  }

  if (answerMatch !== null) {
    const bodyStart = answerMatch.index + answerMatch[0].length;
    const firstRca = RCA_SECTION_HEADER_RE.exec(raw.slice(bodyStart));
    const bodyEnd = firstRca !== null ? bodyStart + firstRca.index : raw.length;
    answer = raw.slice(bodyStart, bodyEnd).trim();
    if (firstRca !== null) rcaRaw = raw.slice(bodyStart + firstRca.index);
  } else {
    const firstRca = RCA_SECTION_HEADER_RE.exec(raw);
    if (firstRca !== null) rcaRaw = raw.slice(firstRca.index);
  }

  const suggestedCommands = extractKubectlCommands(answer);
  const severity = inferSeverity(answer);

  const finding: OneShotFinding = { summary, answer, severity, suggestedCommands };
  if (model !== undefined && model !== '') finding.model = model;

  // ── Structured RCA fields (searched within rcaRaw only) ──────────────────

  const causalBody = extractRcaSection(rcaRaw, CAUSAL_CHAIN_RE);
  if (causalBody) {
    const items = parseBulletList(causalBody);
    if (items.length > 0) finding.causalChain = items;
  }

  const evidenceBody = extractRcaSection(rcaRaw, EVIDENCE_RE);
  if (evidenceBody) {
    const map = parseEvidenceMap(evidenceBody);
    if (map) finding.evidence = map;
  }

  const vsMatch = VALIDITY_SCORE_RE.exec(rcaRaw);
  if (vsMatch) {
    const score = parseFloat(vsMatch[1]);
    finding.validityScore = Math.min(1, Math.max(0, score));
  }

  const remBody = extractRcaSection(rcaRaw, REMEDIATION_STEPS_RE);
  if (remBody) {
    const items = parseBulletList(remBody);
    if (items.length > 0) finding.remediationSteps = items;
  }

  return finding;
}

/**
 * Walk fenced-block lines, joining backslash continuations and collecting
 * all kubectl commands. Non-kubectl lines are ignored unless they continue
 * a preceding kubectl line.
 *
 * A trailing continuation (last line ends with `\`) is flushed as-is.
 */
function extractCommandsFromLines(lines: string[]): string[] {
  const commands: string[] = [];
  let current = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (current !== '') {
      if (trimmed.endsWith('\\')) {
        current += ' ' + trimmed.slice(0, -1).trim();
      } else {
        commands.push(trimmed ? current + ' ' + trimmed : current);
        current = '';
      }
    } else if (trimmed.startsWith('kubectl ')) {
      if (trimmed.endsWith('\\')) {
        current = trimmed.slice(0, -1).trim();
      } else {
        commands.push(trimmed);
      }
    }
  }
  if (current !== '') commands.push(current);
  return commands;
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
    for (const cmd of extractCommandsFromLines(m[1].split('\n'))) {
      add(cmd);
    }
  }

  // Inline spans: `kubectl …`
  const inlineRe = /`(kubectl [^`\n]+)`/g;
  while ((m = inlineRe.exec(text)) !== null) add(m[1]);

  return commands;
}

// Negative lookbehind excludes "no <critical-term>" and "without <critical-term>" so
// healthy summaries like "no outage detected" or "no unavailable replicas" don't
// false-positive as critical. Uses variable-length lookbehind (ES2018+, Node 22+).
// [ \t]+ (not \s+) prevents cross-line suppression (e.g. "no\ncritical" on separate lines).
const CRITICAL_SIGNAL_RE = /(?<!\b(?:no|without)[ \t]+)\b(?:critical|outage|unavailable)\b/;

/**
 * Matches healthy-summary phrases that should suppress a warning inference.
 * e.g. "no warning events", "without errors", "no crashloopbackoff".
 */
const NEGATION_SUPPRESS_RE =
  /\b(?:no|without)\s+(?:warnings?|errors?|fail(?:s|ed|ing|ures?)?|degraded|back-?off|crashloop(?:backoff)?|oomkilled?)\b/;

const WARNING_SIGNAL_RE =
  /\b(?:warning|degraded|oomkilled?|crashloop(?:backoff)?|back-?off|fail(?:s|ed|ing|ures?)?|error)\b/;

/**
 * Infer a severity level from answer text using keyword matching.
 *
 * Defaults to "info" when no signal keywords are present.
 */
export function inferSeverity(text: string): 'critical' | 'warning' | 'info' {
  const lower = text.toLowerCase();
  if (CRITICAL_SIGNAL_RE.test(lower)) return 'critical';
  // Suppress false positives from healthy summaries like "no warning events" / "no errors".
  if (NEGATION_SUPPRESS_RE.test(lower)) return 'info';
  if (WARNING_SIGNAL_RE.test(lower)) return 'warning';
  return 'info';
}
