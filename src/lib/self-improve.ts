/**
 * Self-improvement core logic for Heimdall.
 *
 * Captures eval failures as structured learning entries, writes them to a
 * persistent JSONL log, and can generate a reflection prompt for proposing
 * concrete instruction improvements.
 *
 * Inspired by Karpathy's self-research loop and loop-engineer patterns:
 * run → evaluate → learn → improve → repeat.
 */
import { appendJsonlLine, generateEntryId, readJsonlFile } from './jsonl.ts';
import { resolve } from 'node:path';
import type { HeimdallConfig } from './config.ts';
import type { TaskHistoryEntry } from './task-history.ts';
import { buildTaskHistoryContext } from './task-history.ts';
import { retrieveSimilarEntries } from './rag.ts';

export interface LearningEntry {
  /** Unique entry ID (timestamp + random suffix). */
  id: string;
  /** ISO-8601 timestamp of when the failure was captured. */
  timestamp: string;
  /** Scenario description from the YAML file. */
  scenario: string;
  /** Prompt sent to the agent during the eval run. */
  prompt: string;
  /** Assertion failures from the eval run. */
  failures: string[];
  /** Auto-generated suggestion for improving the instructions. */
  suggestion: string;
}

type FailureHandler = (failure: string, scenario: string) => string | null;

/** Maps failure message prefixes to suggestion builders. Handlers return null to emit nothing. */
const FAILURE_HANDLERS: Array<[string, FailureHandler]> = [
  [
    'Severity:',
    (failure, scenario) => {
      const m = failure.match(/expected "([^"]+)", got "([^"]+)"/);
      if (!m) return null;
      return (
        `Severity miscalibrated: expected "${m[1]}", got "${m[2]}" for "${scenario}". ` +
        `Strengthen ${m[1]}-tier signal words in RESPONSE_FORMAT or the relevant subagent instruction.`
      );
    },
  ],
  [
    'Missing expected keyword:',
    (failure, scenario) => {
      const kw = failure.match(/"([^"]+)"/)?.[1];
      if (!kw) return null;
      return (
        `Required term "${kw}" absent in answer for "${scenario}". ` +
        `Add "${kw}" to the Focus section of the relevant SUBAGENT_INSTRUCTIONS entry so the agent is guided to mention it.`
      );
    },
  ],
  [
    'Found forbidden keyword:',
    (failure, scenario) => {
      const kw = failure.match(/"([^"]+)"/)?.[1];
      if (!kw) return null;
      return (
        `Forbidden term "${kw}" appeared in answer for "${scenario}". ` +
        `Add an explicit constraint to the relevant SUBAGENT_INSTRUCTIONS entry to avoid this term.`
      );
    },
  ],
  [
    'Agent error:',
    (failure, scenario) =>
      `Agent execution failed for "${scenario}": ${failure.slice('Agent error:'.length).trimStart().slice(0, 120)}. ` +
      `Check prompt clarity, tool availability, or ANTHROPIC_API_KEY.`,
  ],
];

function handleFailure(failure: string, scenario: string): string | null {
  for (const [prefix, handler] of FAILURE_HANDLERS) {
    if (failure.startsWith(prefix)) return handler(failure, scenario);
  }
  return `Unexpected failure in "${scenario}": ${failure}`;
}

/**
 * Derive a human-readable instruction-improvement suggestion from assertion
 * failures. Each failure type maps to a targeted suggestion.
 */
export function generateSuggestion(scenario: string, prompt: string, failures: string[]): string {
  if (failures.length === 0) return 'No actionable suggestion generated.';
  const parts = failures
    .map((failure) => handleFailure(failure, scenario))
    .filter((part): part is string => part !== null);
  return parts.join(' | ');
}

/**
 * Format a list of LearningEntry objects as a numbered Markdown scenario list.
 * Used in both the interactive reflection prompt and the automated self-loop prompt.
 */
export function formatLearningEntries(entries: LearningEntry[]): string {
  return entries
    .map(
      (e, i) =>
        `### ${i + 1}. "${e.scenario}"\n` +
        `**Prompt**: ${e.prompt}\n` +
        `**Failures**:\n${e.failures.map((f) => `- ${f}`).join('\n')}\n` +
        `**Auto-suggestion**: ${e.suggestion}`,
    )
    .join('\n\n');
}

/** Build a LearningEntry from a scenario name, prompt, and assertion failures. */
export function buildLearningEntry(
  scenario: string,
  prompt: string,
  failures: string[],
): LearningEntry {
  const { id, timestamp } = generateEntryId();
  return { id, timestamp, scenario, prompt, failures, suggestion: generateSuggestion(scenario, prompt, failures) };
}

/** Separator joining distinct sections of a reflection prompt. */
export const SECTION_SEPARATOR = '\n\n---\n\n';

/** Join reflection-prompt sections with the standard separator. */
export function joinSections(sections: string[]): string {
  return sections.join(SECTION_SEPARATOR);
}

/** Format a learning-entries scenario list for a reflection prompt, or '' when there are none. */
export function formatScenarioSection(entries: LearningEntry[]): string {
  return entries.length > 0 ? formatLearningEntries(entries) : '';
}

/**
 * Wrap `value` in a single-element array when `condition` is true, or return
 * `[]` otherwise. Shared by buildReflectionPrompt and buildAutoReflectionPrompt
 * to conditionally splice an optional section into their `sections` array.
 */
export function includeIf<T>(condition: boolean, value: T): T[] {
  return condition ? [value] : [];
}

/**
 * Assemble the [preamble, scenario-list?, history-section?, ...extra] section
 * array shared by every self-improve/self-loop reflection prompt — pass the
 * result to joinSections(). `historySection` is included only when non-empty.
 */
export function buildPromptSections(
  preamble: string,
  entries: LearningEntry[],
  historySection: string,
  extraSections: string[] = [],
): string[] {
  return [
    preamble,
    ...includeIf(entries.length > 0, formatScenarioSection(entries)),
    ...includeIf(historySection !== '', historySection),
    ...extraSections,
  ];
}

/** Append a single learning entry to a JSONL log file (creates the file if absent). */
export async function appendLearningEntry(entry: LearningEntry, logPath: string): Promise<void> {
  await appendJsonlLine(entry, logPath);
}

/** Read all learning entries from a JSONL log file. Returns [] if the file does not exist. */
export function readLearningLog(logPath: string): Promise<LearningEntry[]> {
  return readJsonlFile<LearningEntry>(logPath);
}

/**
 * Resolve the learning log path from (highest to lowest priority):
 *   1. cliLogPath (--log-path flag)
 *   2. HEIMDALL_LEARNING_LOG environment variable
 *   3. configLogFile (learning.logFile in heimdall.config.yaml)
 *   4. defaultPath (package-relative scenarios/learning-log.jsonl)
 *
 * Container/lambda deployments use this to redirect the log to a mounted
 * persistent volume so it survives container restarts.
 */
export function resolveLogPath(
  cliLogPath: string | null | undefined,
  configLogFile: string | null | undefined,
  defaultPath: string,
): string {
  if (cliLogPath) return resolve(cliLogPath);
  const envPath = process.env.HEIMDALL_LEARNING_LOG;
  if (envPath) return resolve(envPath);
  if (configLogFile) return resolve(configLogFile);
  return defaultPath;
}

/**
 * Resolve whether to use RAG-based retrieval and the topK to request, from
 * `heimdall.config.yaml`'s `learning.rag` section. Centralizes the flag/topK
 * derivation so self-improve mode computes it once regardless of which code
 * path (--from-log vs. a fresh eval run) needs it.
 *
 * `learningConfig` comes from `loadConfig()`, which fills in valibot defaults
 * recursively — `rag` is always present, so no defensive checks are needed.
 */
export function resolveRagOptions(learningConfig: HeimdallConfig['learning']): {
  useRag: boolean;
  ragTopK: number;
} {
  return {
    useRag: learningConfig.rag.enabled,
    ragTopK: learningConfig.rag.topK,
  };
}

/**
 * Select task history entries relevant to a reflection prompt.
 *
 * When RAG is enabled and there are failures to reflect on, retrieves task
 * history entries that are semantically similar to the failed scenario
 * prompts, rather than taking the last N entries.
 */
function selectRelevantHistory(
  entries: LearningEntry[],
  taskHistory: TaskHistoryEntry[],
  useRag: boolean,
  ragTopK: number,
): TaskHistoryEntry[] {
  if (!useRag || entries.length === 0 || taskHistory.length === 0) return taskHistory;
  const combinedQuery = entries.map((e) => e.prompt).join(' ');
  return retrieveSimilarEntries(combinedQuery, taskHistory, ragTopK, 0);
}

/** Build the "Real-World Investigations" section, or '' when there's no relevant history. */
function buildHistorySection(
  relevantHistory: TaskHistoryEntry[],
  hasFailures: boolean,
  useRag: boolean,
): string {
  if (relevantHistory.length === 0) return '';
  const historyLabel = useRag && hasFailures
    ? 'semantically similar to the failing scenario prompts'
    : 'most recent';
  return `## Real-World Investigations (${historyLabel})\n\n` +
    `The following are real prompts the agent handled. Review them for ` +
    `patterns that suggest missing subagent coverage or miscalibrated severity.\n\n` +
    buildTaskHistoryContext(relevantHistory);
}

/**
 * Build the "N eval scenario(s)" lead-in sentence, pluralized appropriately.
 * Shared with self-loop.ts's buildAutoReflectionPrompt, which needs the same
 * count sentence but (unlike buildFailurePart) has no zero-entries special case.
 */
export function buildFailureSentence(entries: LearningEntry[]): string {
  return `The agent failed ${entries.length} eval scenario${entries.length === 1 ? '' : 's'}. `;
}

/** Build the failure-summary sentence introducing the reflection prompt. */
function buildFailurePart(entries: LearningEntry[]): string {
  if (entries.length === 0) return `No eval failures this run.`;
  return buildFailureSentence(entries) +
    `For each failure, analyze the root cause and propose the **exact text change** to ` +
    `\`src/lib/instructions.ts\` (or a specific \`SUBAGENT_INSTRUCTIONS\` entry) that would fix it. ` +
    `Be specific: quote the line(s) to change and what to replace them with.`;
}

/** Build the "Your task" checklist, scaled to which sections (failures/history) are present. */
function buildTaskItemsSection(hasFailures: boolean, hasHistory: boolean): string {
  const taskItems: string[] = [];
  if (hasFailures) {
    taskItems.push(
      `For each eval failure, provide:\n` +
      `1. **Root cause** — why did the agent fail this assertion?\n` +
      `2. **Instruction fix** — which exact text in \`src/lib/instructions.ts\` should change, and how?`,
    );
  }
  if (hasHistory) {
    taskItems.push(
      `For the task history, identify:\n` +
      `3. **Coverage gaps** — are there prompt patterns that don't match any specialist subagent?\n` +
      `4. **Severity calibration** — do any findings seem over- or under-triaged?`,
    );
  }
  return `## Your task\n\n` + taskItems.join('\n\n');
}

/**
 * Build a meta-prompt that can be fed to any LLM to propose specific changes
 * to src/lib/instructions.ts based on recurring eval failures and real-task
 * history.
 *
 * This closes the self-research loop: observe failures → generate a focused
 * prompt → use the model to propose improvements → review → apply → re-eval.
 *
 * When `useRag` is true and `entries` is non-empty, semantically similar task
 * history entries are retrieved by matching against the failed scenario prompts
 * instead of using a simple recency-based slice.
 *
 * @param entries     Eval-run failures to reflect on.
 * @param taskHistory Full task history log.
 * @param useRag      Use semantic retrieval over task history (requires entries).
 * @param ragTopK     Max task history entries to retrieve when useRag is true.
 */
export function buildReflectionPrompt(
  entries: LearningEntry[],
  taskHistory: TaskHistoryEntry[] = [],
  useRag = false,
  ragTopK = 10,
): string {
  if (entries.length === 0 && taskHistory.length === 0) {
    return 'No failures to reflect on. All scenarios passed!';
  }

  const hasFailures = entries.length > 0;
  const relevantHistory = selectRelevantHistory(entries, taskHistory, useRag, ragTopK);
  const hasHistory = relevantHistory.length > 0;

  const historySection = buildHistorySection(relevantHistory, hasFailures, useRag);

  const sections: string[] = buildPromptSections(
    `You are reviewing self-evaluation results for the Heimdall Kubernetes SRE agent.\n\n` +
      buildFailurePart(entries),
    entries,
    historySection,
  );

  sections.push(buildTaskItemsSection(hasFailures, hasHistory));
  sections.push(`Focus on changes with the highest impact-to-risk ratio. Prefer small, targeted edits over broad rewrites.`);

  return joinSections(sections);
}
