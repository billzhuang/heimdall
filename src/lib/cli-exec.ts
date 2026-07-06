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

/** Sentinel returned when a command succeeds but produces no stdout/stderr. */
export const DEFAULT_NO_OUTPUT_MESSAGE = '(command produced no output)';

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
  /**
   * Prefer stdout over stderr when extracting error detail. Set for tools
   * (e.g. Trivy) that write structured results to stdout even on non-zero exit.
   */
  stdoutFirst?: boolean;
  /**
   * Return the raw error detail as-is, without the "<bin> exited with an
   * error:" prefix, when detail is non-empty. Set for tools whose non-zero
   * exit code is a valid result (e.g. Trivy exits 1 when vulnerabilities are
   * found) rather than a genuine failure.
   */
  passthroughOnError?: boolean;
}

/** Combine execFile's stdout/stderr into the model-facing success output. */
export function formatExecSuccessOutput(stdout: string, stderr: string, noOutputMessage: string): string {
  return stdout.trim() || stderr.trim() || noOutputMessage;
}

/**
 * Build the model-facing message for a failed exec.
 *
 * When `passthroughOnError` is set and `detail` is non-empty, `detail` is
 * returned as-is (no prefix) — used for tools whose non-zero exit is a valid
 * result rather than a genuine failure (e.g. Trivy exits 1 when
 * vulnerabilities are found). Otherwise the message is prefixed with
 * "<bin> exited with an error:", falling back to `fallbackDetail` when
 * `detail` is empty.
 */
export function formatExecErrorMessage(
  bin: string,
  detail: string,
  passthroughOnError: boolean,
  fallbackDetail: string,
): string {
  if (passthroughOnError && detail) return detail;
  return `${bin} exited with an error:\n${passthroughOnError ? fallbackDetail : detail}`;
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
    stdoutFirst = false, passthroughOnError = false,
  } = params;

  try {
    const { stdout, stderr } = await execFileAsync(bin, argv, { encoding: 'utf8', ...execOptions });
    const output = applyRedaction(formatExecSuccessOutput(stdout, stderr, noOutputMessage), regexRedactionRules);
    await writeAudit({ ts: startTs, level: 'audit', cmd, allowed: true, durationMs: Date.now() - startMs, outcome: 'ok' }, audit);
    return truncate(output);
  } catch (error) {
    const detail = applyRedaction(getExecErrorDetail(error, stdoutFirst), regexRedactionRules);
    const fallbackDetail = applyRedaction(String(error), regexRedactionRules);
    await writeAudit({ ts: startTs, level: 'audit', cmd, allowed: true, durationMs: Date.now() - startMs, outcome: 'error' }, audit);
    return truncate(formatExecErrorMessage(bin, detail, passthroughOnError, fallbackDetail));
  }
}
