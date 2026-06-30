/**
 * Task history logging for Heimdall.
 *
 * Every real investigation (heimdall -p "..." --json) is appended to a
 * persistent JSONL log, giving the self-improve reflector a corpus of
 * real-world prompts and findings alongside the synthetic eval failures.
 *
 * Disable logging per-invocation with --no-learn, or globally via
 * `learning.enabled: false` in heimdall.config.yaml.
 */
import { appendJsonlLine, generateEntryId, readJsonlFile } from './jsonl.ts';

export interface TaskHistoryEntry {
  /** Unique entry ID (timestamp + random suffix). */
  id: string;
  /** ISO-8601 timestamp of when the investigation completed. */
  timestamp: string;
  /** User prompt sent to the agent. */
  prompt: string;
  /** Model identifier used for the investigation. */
  model: string;
  /** Severity of the finding: 'critical' | 'warning' | 'info'. */
  severity: string;
  /** One-sentence summary from the finding. */
  summary: string;
}

/** Build a TaskHistoryEntry from investigation metadata. */
export function buildTaskHistoryEntry(
  prompt: string,
  model: string,
  severity: string,
  summary: string,
): TaskHistoryEntry {
  const { id, timestamp } = generateEntryId();
  return { id, timestamp, prompt, model, severity, summary };
}

/** Append a single task history entry to a JSONL file (creates if absent). */
export async function appendTaskHistoryEntry(
  entry: TaskHistoryEntry,
  logPath: string,
): Promise<void> {
  await appendJsonlLine(entry, logPath);
}

/** Read all task history entries from a JSONL file. Returns [] if the file does not exist. */
export function readTaskHistory(logPath: string): Promise<TaskHistoryEntry[]> {
  return readJsonlFile<TaskHistoryEntry>(logPath, () => {
    console.warn(`[heimdall] task-history: skipping malformed JSONL line in ${logPath}`);
  });
}

/**
 * Format the most recent task history entries as context text for a
 * reflection prompt. Caps at maxEntries (default 20) to keep prompts
 * from growing unbounded.
 */
export function buildTaskHistoryContext(entries: TaskHistoryEntry[], maxEntries = 20): string {
  if (entries.length === 0) return 'No task history entries yet.';
  // entries.slice(-0) === entries.slice(0) (full array), so guard explicitly.
  const recent = maxEntries > 0 ? entries.slice(-maxEntries) : [];
  if (recent.length === 0) return 'No task history entries yet.';
  return recent
    .map(
      (e, i) =>
        `### ${i + 1}. "${e.prompt}"\n` +
        `**Date**: ${e.timestamp} | **Severity**: ${e.severity}\n` +
        `**Summary**: ${e.summary}`,
    )
    .join('\n\n');
}
