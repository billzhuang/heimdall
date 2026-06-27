/**
 * Runbook loader: reads local markdown runbooks and returns them as system context.
 *
 * Runbooks are loaded at agent startup from paths listed in `heimdall.config.yaml`.
 * When a query is supplied, only runbooks whose tags overlap with the query are
 * included; untagged runbooks always load. Without a query, all runbooks load.
 * Output is capped to protect the model's context window.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RunbookConfig {
  path: string;
  tags?: string[] | null;
}

const MAX_RUNBOOK_CHARS = 8_000;
const TRUNCATION_MARKER = '\n[truncated]';

/**
 * True when any of the given tags appears as a case-insensitive whole-word token
 * in `query`. Untagged runbooks (empty or null tags) always match.
 */
export function tagsMatch(tags: string[] | null | undefined, query: string): boolean {
  if (!tags || tags.length === 0) return true;
  const q = query.toLowerCase();
  return tags.some((tag) => {
    const escaped = tag.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`).test(q);
  });
}

/**
 * Read a single runbook file, logging a specific warning on error and returning
 * null so the caller can skip it. Distinguishes ENOENT ("not found") from other
 * read errors (e.g. EPERM, EISDIR) for clearer operator feedback.
 *
 * Using a single try/catch avoids the TOCTOU race between an existsSync check
 * and the subsequent readFileSync call.
 */
export function readRunbook(absPath: string): string | null {
  try {
    return readFileSync(absPath, 'utf-8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      process.stderr.write(`[heimdall] Runbook not found: ${absPath}\n`);
    } else {
      process.stderr.write(`[heimdall] Could not read runbook ${absPath}: ${err}\n`);
    }
    return null;
  }
}

/**
 * Load and concatenate runbook files.
 *
 * @param configDir  - directory relative to which `entry.path` values are resolved.
 * @param configs    - runbook entries from the config.
 * @param query      - optional user query for tag filtering; omit to load all runbooks.
 * @returns Combined runbook text (with per-file headers), capped at MAX_RUNBOOK_CHARS.
 */
export function loadRunbooks(configDir: string, configs: RunbookConfig[], query?: string): string {
  if (!configs || configs.length === 0) return '';

  const parts: string[] = [];
  let totalChars = 0;

  for (const entry of configs) {
    if (query !== undefined && !tagsMatch(entry.tags, query)) continue;

    const absPath = resolve(configDir, entry.path);
    const text = readRunbook(absPath);
    if (!text) continue;

    const header = `\n\n### Runbook: ${entry.path}\n\n`;
    const budget = MAX_RUNBOOK_CHARS - totalChars - header.length;
    if (budget <= 0) break;

    // Subtract marker length from the slice budget so the combined body never
    // exceeds the remaining budget when truncation is applied. When the budget
    // is smaller than the marker itself, use a partial marker rather than a
    // negative slice index (which would trim from the end in JS).
    const body = text.length <= budget
      ? text
      : budget <= TRUNCATION_MARKER.length
        ? TRUNCATION_MARKER.slice(0, budget)
        : text.slice(0, budget - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
    parts.push(header + body);
    totalChars += header.length + body.length;
  }

  return parts.join('');
}
