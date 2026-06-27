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
import { appendJsonlLine, readJsonlFile } from './jsonl.ts';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
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

/**
 * Derive a human-readable instruction-improvement suggestion from assertion
 * failures. Each failure type maps to a targeted suggestion.
 */
export function generateSuggestion(scenario: string, prompt: string, failures: string[]): string {
  if (failures.length === 0) return 'No actionable suggestion generated.';

  const parts: string[] = [];
  for (const failure of failures) {
    if (failure.startsWith('Severity:')) {
      const m = failure.match(/expected "(.+)", got "(.+)"/);
      if (m) {
        parts.push(
          `Severity miscalibrated: expected "${m[1]}", got "${m[2]}" for "${scenario}". ` +
            `Strengthen ${m[1]}-tier signal words in RESPONSE_FORMAT or the relevant subagent instruction.`,
        );
      }
    } else if (failure.startsWith('Missing expected keyword:')) {
      const kw = failure.match(/"(.+)"/)?.[1];
      if (kw) {
        parts.push(
          `Required term "${kw}" absent in answer for "${scenario}". ` +
            `Add "${kw}" to the Focus section of the relevant SUBAGENT_INSTRUCTIONS entry so the agent is guided to mention it.`,
        );
      }
    } else if (failure.startsWith('Found forbidden keyword:')) {
      const kw = failure.match(/"(.+)"/)?.[1];
      if (kw) {
        parts.push(
          `Forbidden term "${kw}" appeared in answer for "${scenario}". ` +
            `Add an explicit constraint to the relevant SUBAGENT_INSTRUCTIONS entry to avoid this term.`,
        );
      }
    } else if (failure.startsWith('Agent error:')) {
      parts.push(
        `Agent execution failed for "${scenario}": ${failure.slice('Agent error: '.length).slice(0, 120)}. ` +
          `Check prompt clarity, tool availability, or ANTHROPIC_API_KEY.`,
      );
    } else {
      parts.push(`Unexpected failure in "${scenario}": ${failure}`);
    }
  }

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
  const now = new Date();
  return {
    id: `${now.getTime()}-${randomBytes(6).toString('hex')}`,
    timestamp: now.toISOString(),
    scenario,
    prompt,
    failures,
    suggestion: generateSuggestion(scenario, prompt, failures),
  };
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

  // When RAG is enabled, retrieve task history entries that are semantically
  // similar to the failed scenario prompts, rather than taking the last N entries.
  let relevantHistory = taskHistory;
  if (useRag && hasFailures && taskHistory.length > 0) {
    const combinedQuery = entries.map((e) => e.prompt).join(' ');
    relevantHistory = retrieveSimilarEntries(combinedQuery, taskHistory, ragTopK, 0);
  }

  const hasHistory = relevantHistory.length > 0;

  const scenarioList = hasFailures ? formatLearningEntries(entries) : '';

  const historyLabel = useRag && hasFailures
    ? 'semantically similar to the failing scenario prompts'
    : 'most recent';
  const historySection = hasHistory
    ? `## Real-World Investigations (${historyLabel})\n\n` +
      `The following are real prompts the agent handled. Review them for ` +
      `patterns that suggest missing subagent coverage or miscalibrated severity.\n\n` +
      buildTaskHistoryContext(relevantHistory)
    : '';

  const failurePart = hasFailures
    ? `The agent failed ${entries.length} eval scenario${entries.length === 1 ? '' : 's'}. ` +
      `For each failure, analyze the root cause and propose the **exact text change** to ` +
      `\`src/lib/instructions.ts\` (or a specific \`SUBAGENT_INSTRUCTIONS\` entry) that would fix it. ` +
      `Be specific: quote the line(s) to change and what to replace them with.`
    : `No eval failures this run.`;

  const sections: string[] = [
    `You are reviewing self-evaluation results for the Heimdall Kubernetes SRE agent.\n\n` + failurePart,
    ...(hasFailures ? [scenarioList] : []),
    ...(hasHistory ? [historySection] : []),
  ];

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
  sections.push(`## Your task\n\n` + taskItems.join('\n\n'));
  sections.push(`Focus on changes with the highest impact-to-risk ratio. Prefer small, targeted edits over broad rewrites.`);

  return sections.join('\n\n---\n\n');
}
