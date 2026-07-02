/**
 * Shared execFile → redact → audit → truncate pipeline for read-only CLI tool
 * runners (aws.ts, cdk.ts). Each runner keeps its own command validation and
 * tokenization — those differ per tool — but the "run the already-validated
 * argv and report the result" tail is identical, so it lives here once.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeAudit, type AuditConfig } from './audit.ts';
import { applyRedaction, type CompiledRedactionRule } from './regex-redact.ts';
import { getExecErrorDetail } from './error-utils.ts';

const execFileAsync = promisify(execFile);

export interface ExecAndReportParams {
  /** Binary to execute; also used in the "<bin> exited with an error" message. */
  bin: string;
  /** Already-validated argv to pass to execFile. */
  argv: string[];
  /** Full command string recorded in the audit log entry. */
  cmd: string;
  /** ISO-8601 timestamp captured before validation, for the audit entry. */
  startTs: string;
  /** Date.now() captured before validation, for computing durationMs. */
  startMs: number;
  execOptions: { timeout: number; maxBuffer: number; cwd?: string };
  audit?: AuditConfig | null;
  regexRedactionRules?: CompiledRedactionRule[];
  noOutputMessage: string;
  truncate: (text: string) => string;
}

/**
 * Run `bin argv` and turn the result into a model-facing string: redact
 * secrets, write an audit entry, and truncate to the caller's size limit.
 * Callers must validate the command against their read-only policy first —
 * this function only executes and reports.
 */
export async function execAndReport(params: ExecAndReportParams): Promise<string> {
  const {
    bin, argv, cmd, startTs, startMs, execOptions,
    audit, regexRedactionRules = [], noOutputMessage, truncate,
  } = params;

  try {
    const { stdout, stderr } = await execFileAsync(bin, argv, { encoding: 'utf8', ...execOptions });
    const rawOutput = stdout.trim() || stderr.trim() || noOutputMessage;
    const output = applyRedaction(rawOutput, regexRedactionRules);
    await writeAudit({ ts: startTs, level: 'audit', cmd, allowed: true, durationMs: Date.now() - startMs, outcome: 'ok' }, audit);
    return truncate(output);
  } catch (error) {
    const rawDetail = getExecErrorDetail(error);
    const detail = applyRedaction(rawDetail, regexRedactionRules);
    await writeAudit({ ts: startTs, level: 'audit', cmd, allowed: true, durationMs: Date.now() - startMs, outcome: 'error' }, audit);
    return truncate(`${bin} exited with an error:\n${detail}`);
  }
}
