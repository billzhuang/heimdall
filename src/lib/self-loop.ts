/**
 * Self-loop core logic for Heimdall.
 *
 * Closes the full automation cycle:
 *   run evals → score → reflect → propose patches → apply → re-score → keep/revert → repeat
 *
 * The reflection prompt instructs the LLM to output structured FIND/REPLACE patches
 * targeting src/lib/instructions.ts so changes are machine-parseable and reversible.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { formatScenarioSection, joinSections } from './self-improve.ts';
import type { LearningEntry } from './self-improve.ts';
import type { TaskHistoryEntry } from './task-history.ts';
import { buildTaskHistoryContext } from './task-history.ts';

export interface SelfLoopPatch {
  find: string;
  replace: string;
}

export interface IterationResult {
  iteration: number;
  baselineScore: number;
  newScore: number;
  proposalCount: number;
  appliedCount: number;
  improved: boolean;
  reverted: boolean;
}

/**
 * Compute a 0–1 pass ratio from eval results.
 * Returns 1.0 when there are no results (vacuously pass).
 */
export function scoreResults(results: Array<{ passed: boolean }>): number {
  if (results.length === 0) return 1;
  return results.filter(r => r.passed).length / results.length;
}

/** Format a 0–1 score fraction as a whole-percent string, e.g. 0.667 -> "67%". */
export function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

/**
 * Build the human-readable summary report printed at the end of a self-loop run.
 * Pure string formatting, factored out of `main()` so it can be unit tested
 * without the eval/LLM/file-system side effects that surround it there.
 */
export function buildSummaryReport(
  iterationHistory: IterationResult[],
  currentScore: number,
  logPath: string,
): string {
  const parts: string[] = ['='.repeat(60) + '\n', 'Self-Loop Summary\n', '='.repeat(60) + '\n'];

  if (iterationHistory.length === 0) {
    parts.push('No iterations were run (all scenarios already passing or LLM unavailable).\n');
  } else {
    for (const r of iterationHistory) {
      // toFixed(0) on a tiny negative delta (e.g. -0.001) yields the string "-0",
      // which reads as a genuine negative — normalize it to "0" before the sign check.
      let delta = ((r.newScore - r.baselineScore) * 100).toFixed(0);
      if (delta === '-0') delta = '0';
      const status = r.reverted ? 'REVERTED' : r.improved ? 'KEPT' : 'NO_CHANGE';
      parts.push(
        `  Iteration ${r.iteration}: ${formatPct(r.baselineScore)} → ${formatPct(r.newScore)}` +
          ` (${delta.startsWith('-') ? '' : '+'}${delta}pp) | ${r.appliedCount} patch${r.appliedCount === 1 ? '' : 'es'} | ${status}\n`,
      );
    }
    parts.push(`\nFinal score: ${formatPct(currentScore)}\n`);
    if (iterationHistory.some((r) => r.improved)) {
      parts.push('instructions.ts was updated. Review changes with: git diff src/lib/instructions.ts\n');
    }
  }

  parts.push('\nProposals saved to: scenarios/self-loop-proposals/\n');
  parts.push('Learning entries saved to: ' + logPath + '\n');

  return parts.join('');
}

/**
 * Build a structured reflection prompt that explicitly asks the LLM to
 * output machine-parseable FIND/REPLACE patches for instructions.ts.
 *
 * The patch format is:
 *   ## Change N
 *   FIND:
 *   ```
 *   <exact text to find>
 *   ```
 *   REPLACE:
 *   ```
 *   <replacement text>
 *   ```
 */
export function buildAutoReflectionPrompt(
  entries: LearningEntry[],
  taskHistory: TaskHistoryEntry[],
  instructionsSnippet: string,
): string {
  const hasFailures = entries.length > 0;
  const hasHistory = taskHistory.length > 0;

  const scenarioList = formatScenarioSection(entries);

  const historySection = hasHistory
    ? `## Recent Real-World Investigations\n\n${buildTaskHistoryContext(taskHistory)}`
    : '';

  const instructionsSection = `## Current instructions.ts content (abbreviated)\n\n\`\`\`\n${instructionsSnippet}\n\`\`\``;

  const patchFormat = `## Output format (REQUIRED — machine-parsed)

For each proposed change, output a block in EXACTLY this format:

## Change N
FIND:
\`\`\`
<exact verbatim text from instructions.ts to find>
\`\`\`
REPLACE:
\`\`\`
<replacement text>
\`\`\`

Rules:
- FIND must be a verbatim substring of instructions.ts — copy it exactly.
- REPLACE is the full replacement for that substring.
- Output only changes that directly address the failures listed above.
- Prefer small, targeted edits. Do not rewrite entire sections.
- If no change is needed, output: NO_CHANGES_NEEDED`;

  const sections = [
    `You are the self-improvement loop for the Heimdall Kubernetes SRE agent.\n\n` +
      `The agent failed ${entries.length} eval scenario${entries.length === 1 ? '' : 's'}. ` +
      `Propose specific text patches to \`src/lib/instructions.ts\` that would fix these failures.`,
    ...(hasFailures ? [scenarioList] : []),
    ...(hasHistory ? [historySection] : []),
    instructionsSection,
    patchFormat,
  ];

  return joinSections(sections);
}

/**
 * Parse LLM output for structured FIND/REPLACE patch blocks.
 *
 * Accepts:
 *   ## Change N
 *   FIND:
 *   ```
 *   ...
 *   ```
 *   REPLACE:
 *   ```
 *   ...
 *   ```
 */
export function parseProposals(llmOutput: string): SelfLoopPatch[] {
  if (llmOutput.trim() === 'NO_CHANGES_NEEDED') return [];

  const patches: SelfLoopPatch[] = [];

  // Match blocks starting with "## Change" or "## Proposed Change"
  const blockPattern = /##\s+(?:Proposed\s+)?Change\s+\d+[\s\S]*?(?=##\s+(?:Proposed\s+)?Change\s+\d+|$)/gi;
  const blocks = llmOutput.match(blockPattern) ?? [llmOutput];

  for (const block of blocks) {
    const find = extractFencedSection(block, 'FIND');
    const replace = extractFencedSection(block, 'REPLACE');

    if (find === null || replace === null || !find.trim()) continue;

    patches.push({ find, replace });
  }

  return patches;
}

const FENCED_SECTION_PATTERNS: Record<'FIND' | 'REPLACE', RegExp> = {
  FIND: /FIND:\s*```[^\n]*\n([\s\S]*?)```/,
  REPLACE: /REPLACE:\s*```[^\n]*\n([\s\S]*?)```/,
};

/**
 * Extract the content of a `LABEL:` fenced code block (e.g. FIND/REPLACE),
 * or null if the block is absent.
 */
function extractFencedSection(block: string, label: 'FIND' | 'REPLACE'): string | null {
  const match = block.match(FENCED_SECTION_PATTERNS[label]);
  return match ? match[1] : null;
}

/**
 * Apply a list of FIND/REPLACE patches to instructions.ts.
 * Returns the number of patches that were successfully applied.
 *
 * Patches that don't match the current content are silently skipped
 * (the content may have already changed from a prior patch).
 */
export async function applyProposals(
  patches: SelfLoopPatch[],
  instructionsPath: string,
): Promise<number> {
  let content = await readFile(instructionsPath, 'utf8');
  let applied = 0;

  for (const patch of patches) {
    const occurrences = content.split(patch.find).length - 1;
    if (occurrences === 1) {
      content = content.replace(patch.find, () => patch.replace);
      applied++;
    }
  }

  if (applied > 0) {
    await writeFile(instructionsPath, content, 'utf8');
  }

  return applied;
}

/**
 * Restore instructions.ts to a previously captured snapshot.
 */
export async function revertToSnapshot(
  snapshot: string,
  instructionsPath: string,
): Promise<void> {
  await writeFile(instructionsPath, snapshot, 'utf8');
}

/**
 * Read and return the current content of instructions.ts as a snapshot.
 */
export async function snapshotInstructions(instructionsPath: string): Promise<string> {
  return readFile(instructionsPath, 'utf8');
}

/**
 * Extract a representative snippet of instructions.ts to include in the
 * reflection prompt (avoids sending the full file to keep tokens bounded).
 *
 * Returns SUBAGENT_INSTRUCTIONS + RESPONSE_FORMAT sections (first 4000 chars).
 */
export function extractInstructionsSnippet(content: string): string {
  const maxLen = 4000;
  if (content.length <= maxLen) return content;

  // Try to include the response format and subagent instructions sections.
  const responseFormatIdx = content.indexOf('RESPONSE_FORMAT');
  const subagentIdx = content.indexOf('SUBAGENT_INSTRUCTIONS');
  const sectionStarts = [responseFormatIdx, subagentIdx].filter(i => i >= 0);
  const startIdx = sectionStarts.length > 0 ? Math.min(...sectionStarts) : 0;

  return content.slice(startIdx, startIdx + maxLen) + '\n... (truncated)';
}
