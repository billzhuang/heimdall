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
import { escapeRegExpLiteral } from './regexp-utils.ts';

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
    const escaped = escapeRegExpLiteral(tag.toLowerCase());
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
 * Truncate `text` to fit within `budget` characters, appending TRUNCATION_MARKER
 * when it doesn't fit whole.
 *
 * Subtracts the marker length from the slice budget so the combined result
 * never exceeds `budget`. When `budget` is smaller than the marker itself,
 * returns a partial marker rather than using a negative slice index (which
 * would trim from the end of `text` in JS). Assumes `budget > 0`.
 */
export function truncateToBudget(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, budget);
  return text.slice(0, budget - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
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

    const body = truncateToBudget(text, budget);
    parts.push(header + body);
    totalChars += header.length + body.length;
  }

  return parts.join('');
}
