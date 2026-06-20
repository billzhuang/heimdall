import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

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
    const line = JSON.stringify(entry);
    if (audit.file) {
      try {
        await appendFile(audit.file, line + '\n', 'utf8');
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') {
          try {
            await mkdir(dirname(audit.file), { recursive: true });
            await appendFile(audit.file, line + '\n', 'utf8');
          } catch {
            process.stderr.write(line + '\n');
          }
        } else {
          process.stderr.write(line + '\n');
        }
      }
    } else {
      process.stderr.write(line + '\n');
    }
  } catch {
    // Audit failures must never disrupt the main execution path.
  }
}
