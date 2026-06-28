/**
 * Event sink for watch-mode findings.
 *
 * Persists event digests to a local JSONL file and/or a webhook URL after
 * each diagnosis completes. Failures are logged to stderr and never propagate
 * so the watch loop continues uninterrupted.
 */
import { appendJsonlLine } from './jsonl.ts';
import { withTimeout } from './http.ts';
import type { WatchFinding } from './watch.ts';

export interface EventSinkConfig {
  /** Append each event digest as a JSONL line to this file path. */
  filePath?: string | null;
  /** POST each event digest as JSON to this URL. */
  webhookUrl?: string | null;
  /** S3 bucket for event digest uploads (reserved; requires AWS CLI). */
  s3Bucket?: string | null;
}

/** The structured record written to each sink. */
export interface EventSinkRecord {
  timestamp: string;
  event: {
    namespace: string;
    reason: string;
    objectKind: string;
    objectName: string;
    message: string;
  };
  diagnosis: string | undefined;
  severity: string;
}

function findingToRecord(finding: WatchFinding): EventSinkRecord {
  return {
    timestamp: finding.ts,
    event: {
      namespace: finding.namespace,
      reason: finding.reason,
      objectKind: finding.objectKind,
      objectName: finding.objectName,
      message: finding.message,
    },
    diagnosis: finding.diagnosis,
    severity: 'warning',
  };
}

export class EventSink {
  private readonly cfg: EventSinkConfig;

  constructor(config: EventSinkConfig) {
    this.cfg = config;
  }

  async write(finding: WatchFinding): Promise<void> {
    const record = findingToRecord(finding);

    if (this.cfg.filePath) {
      try {
        await appendJsonlLine(record, this.cfg.filePath);
      } catch (err) {
        process.stderr.write(`[heimdall-watch] EventSink file error: ${String(err)}\n`);
      }
    }

    if (this.cfg.webhookUrl) {
      const url = this.cfg.webhookUrl;
      const body = JSON.stringify(record);
      try {
        await withTimeout(10_000, async (signal) => {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal,
          });
          if (!res.ok) {
            process.stderr.write(`[heimdall-watch] EventSink webhook HTTP ${res.status}\n`);
          }
          await res.text();
        });
      } catch (err) {
        process.stderr.write(`[heimdall-watch] EventSink webhook error: ${String(err)}\n`);
      }
    }

    if (this.cfg.s3Bucket) {
      process.stderr.write(
        `[heimdall-watch] EventSink: s3Bucket sink is not yet implemented (bucket: ${this.cfg.s3Bucket})\n`,
      );
    }
  }
}

/**
 * Create an EventSink from config, or return null when no sinks are configured.
 * The null return lets call sites skip the write call entirely.
 */
export function createEventSink(config: EventSinkConfig | null | undefined): EventSink | null {
  if (!config) return null;
  if (!config.filePath && !config.webhookUrl && !config.s3Bucket) return null;
  return new EventSink(config);
}
