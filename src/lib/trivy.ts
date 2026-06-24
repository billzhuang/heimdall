/**
 * Executes read-only Trivy scan commands on behalf of the agent.
 *
 * Design notes:
 * - Arguments are passed to `execFile` (no shell), making model-supplied image
 *   refs injection-safe — there is no shell expansion and nothing pipes into
 *   destructive commands.
 * - Every command is validated against the read-only policy in trivy-safety.ts.
 * - Output is capped to protect the model's context window.
 * - Trivy is disabled by default (`tools.trivyScan: false`) and is gated at
 *   the tool layer; this module runs only when the tool is explicitly enabled.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateTrivyCommand } from './trivy-safety.ts';
import { makeTruncate } from './output-truncation.ts';
import { writeAudit, type AuditConfig } from './audit.ts';
import { BLOCKED_PREFIX } from './harness.ts';
import { applyRedaction, type CompiledRedactionRule } from './regex-redact.ts';

const execFileAsync = promisify(execFile);

// Image scans may pull DB updates on first run; 60 s gives them room.
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024; // 32 MiB — JSON reports can be large
const MAX_RESULT_CHARS = 50_000;
const truncate = makeTruncate(MAX_RESULT_CHARS, 'use --severity CRITICAL,HIGH or scan a more specific image');

export const NO_OUTPUT_MESSAGE = '(trivy produced no output)';

export interface RunTrivyOptions {
  /** Audit logging config. When enabled, a JSON line is written for every call. */
  audit?: AuditConfig | null;
  /** User-configured regex redaction rules compiled at startup. */
  regexRedactionRules?: CompiledRedactionRule[];
  /** Execution timeout in milliseconds (default: 60 000). */
  timeoutMs?: number | null;
}

/**
 * Validate and run a Trivy scan command. Returns the command output (or
 * a descriptive error message) as a string suitable for returning to the model.
 *
 * @param scanType  Trivy scan type: "image" | "fs" | "config" | "sbom"
 * @param target    Image ref, filesystem path, or IaC directory to scan
 * @param extraArgs Additional validated flags (e.g. ["--severity", "CRITICAL,HIGH", "--format", "json"])
 * @param options   Runtime options (audit, redaction, timeout)
 */
export async function runTrivy(
  scanType: string,
  target: string,
  extraArgs: string[],
  options: RunTrivyOptions = {},
): Promise<string> {
  const { audit, regexRedactionRules = [], timeoutMs } = options;
  const execTimeoutMs = (timeoutMs != null && timeoutMs > 0) ? timeoutMs : DEFAULT_EXEC_TIMEOUT_MS;

  const startTs = new Date().toISOString();
  const startMs = Date.now();

  if (!scanType || !target) {
    return 'Error: scan type and target are required.';
  }

  // Build argv that will be passed to execFile. We construct the full command
  // string solely for audit logging and validation; execution uses the argv.
  // The `--` end-of-flags marker ensures `target` is always treated as a
  // positional argument even when it starts with `-` (e.g. a mistyped image ref
  // like `--download-db-only`), preventing flag-injection via the target param.
  const argv: string[] = [scanType, ...extraArgs, '--', target];
  const cmd = `trivy ${argv.join(' ')}`;

  const validation = validateTrivyCommand(cmd);
  if (!validation.allowed) {
    await writeAudit({ ts: startTs, level: 'audit', cmd, allowed: false, outcome: 'blocked' }, audit);
    return `${BLOCKED_PREFIX}${validation.reason}`;
  }

  try {
    const { stdout, stderr } = await execFileAsync('trivy', argv, {
      encoding: 'utf8',
      timeout: execTimeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
    });

    const rawOutput = stdout.trim() || stderr.trim() || NO_OUTPUT_MESSAGE;
    const output = applyRedaction(rawOutput, regexRedactionRules);
    await writeAudit({ ts: startTs, level: 'audit', cmd, allowed: true, durationMs: Date.now() - startMs, outcome: 'ok' }, audit);
    return truncate(output);
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string };
    // Trivy exits non-zero when vulnerabilities are found (exit code 1) — that
    // is a valid result, not a tool failure. Capture stdout/stderr as output.
    const rawDetail = (err.stdout || err.stderr || err.message || String(error)).trim();
    const detail = applyRedaction(rawDetail, regexRedactionRules);
    await writeAudit({ ts: startTs, level: 'audit', cmd, allowed: true, durationMs: Date.now() - startMs, outcome: 'error' }, audit);
    // If there is actual scan output in stdout, return it even if the exit code was non-zero.
    if (detail) return truncate(detail);
    return truncate(`trivy exited with an error:\n${String(error)}`);
  }
}
