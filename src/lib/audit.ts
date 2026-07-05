import { appendJsonlLine } from './jsonl.ts';

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
    if (audit.file) {
      try {
        await appendJsonlLine(entry, audit.file);
        return;
      } catch {
        // Falls through to the stderr sink below.
      }
    }
    process.stderr.write(JSON.stringify(entry) + '\n');
  } catch {
    // Audit failures must never disrupt the main execution path.
  }
}
