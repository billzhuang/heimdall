import { appendJsonlLine } from './jsonl.ts';
import { BLOCKED_PREFIX } from './harness.ts';

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

/**
 * Write a "blocked" audit entry and return the model-facing
 * `BLOCKED_PREFIX + reason` string. Shared by every read-only CLI runner
 * (kubectl, AWS CLI, CDK, Trivy) so the audit-then-report sequence for a
 * rejected command lives in one place.
 */
export async function reportBlocked(
  cmd: string,
  startTs: string,
  audit: AuditConfig | null | undefined,
  reason: string,
): Promise<string> {
  await writeAudit({ ts: startTs, level: 'audit', cmd, allowed: false, outcome: 'blocked' }, audit);
  return `${BLOCKED_PREFIX}${reason}`;
}
