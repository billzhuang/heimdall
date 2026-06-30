import { appendFile } from 'node:fs/promises';
import { withMkdirRetry } from './jsonl.ts';

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

export async function writeAudit(entry: AuditEntry, audit: AuditConfig | null | undefined): Promise<void> {
  try {
    if (!audit?.enabled) return;
    const line = JSON.stringify(entry) + '\n';
    if (!audit.file) {
      process.stderr.write(line);
      return;
    }
    const file = audit.file;
    await withMkdirRetry(file, () => appendFile(file, line, 'utf8'), () => {
      process.stderr.write(line);
    });
  } catch {
    // Audit failures must never disrupt the main execution path.
  }
}
