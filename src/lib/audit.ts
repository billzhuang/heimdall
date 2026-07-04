import { appendFile } from 'node:fs/promises';
import { withMkdirRetry } from './fs-retry.ts';

export interface AuditConfig {
  enabled: boolean;
  /** Path to a JSONL file. Omit (or set null) to write to stderr. */
  file?: string | null;
}

export interface AuditEntry {
  ts: string;
  level: 'audit';
  cmd: string;
  context?: string;
  allowed: boolean;
  cached?: boolean;
  durationMs?: number;
  outcome: 'ok' | 'blocked' | 'error';
}

/** Append `line` to `file`, creating its parent directory on ENOENT and retrying once. */
async function appendAuditLine(file: string, line: string): Promise<boolean> {
  try {
    await withMkdirRetry(file, () => appendFile(file, line, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

export async function writeAudit(entry: AuditEntry, audit: AuditConfig | null | undefined): Promise<void> {
  try {
    if (!audit?.enabled) return;
    const line = JSON.stringify(entry) + '\n';
    if (!audit.file || !(await appendAuditLine(audit.file, line))) {
      process.stderr.write(line);
    }
  } catch {
    // Audit failures must never disrupt the main execution path.
  }
}
