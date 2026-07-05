/**
 * Shared "historical context block" formatter for prompt injection.
 *
 * The RAG (task-history) and baseline (recurring-anomaly) context builders
 * share the same shape: bail out on an empty list, prepend a preamble that
 * marks the content as untrusted historical reference, then join per-entry
 * Markdown blocks with a blank line.
 */
export function buildContextBlock<T>(
  entries: T[],
  preamble: string,
  formatEntry: (entry: T, index: number) => string,
): string {
  if (entries.length === 0) return '';
  return preamble + entries.map(formatEntry).join('\n\n');
}
