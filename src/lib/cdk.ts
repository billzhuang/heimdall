/**
 * Executes read-only CDK CLI commands on behalf of the agent.
 *
 * Design notes:
 * - Commands are tokenized and run with `execFile` (no shell), so shell
 *   metacharacters in model-supplied arguments are inert — no injection surface.
 * - Every command is validated against the read-only policy in cdk-safety.ts.
 * - Output is capped to protect the model's context window.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateCdkCommand, tokenizeCdkCommand } from './cdk-safety.ts';
import { makeTruncate } from './output-truncation.ts';
import { writeAudit, type AuditConfig, type AuditEntry } from './audit.ts';
import { BLOCKED_PREFIX } from './harness.ts';
import { applyRedaction, type CompiledRedactionRule } from './regex-redact.ts';
import { getExecErrorDetail } from './error-utils.ts';

const execFileAsync = promisify(execFile);

const EXEC_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024; // 16 MiB
const MAX_RESULT_CHARS = 20_000;
const truncate = makeTruncate(MAX_RESULT_CHARS, 'narrow the query with stack selectors or --filter');

export const NO_OUTPUT_MESSAGE = '(command produced no output)';

export interface RunCdkOptions {
  audit?: AuditConfig | null;
  regexRedactionRules?: CompiledRedactionRule[];
  /**
   * Working directory for the CDK command. CDK commands like `synth` and `diff`
   * require the CDK app to be present in the working directory (or specified via --app).
   * Defaults to process.cwd().
   */
  cwd?: string;
}

/**
 * Tokenize CDK CLI args. Delegates to the shared `tokenizeCdkCommand` from
 * cdk-safety.ts (same tokenizer used at validation time) then strips the
 * leading `cdk` token if present, so validation and execution can never diverge.
 */
export function tokenizeCdkArgs(input: string): string[] {
  const tokens = tokenizeCdkCommand(input);
  if (tokens.length > 0 && tokens[0].toLowerCase() === 'cdk') {
    tokens.shift();
  }
  return tokens;
}

/** Builds the shared fields of a CDK audit entry so call sites only vary outcome/duration. */
function cdkAuditEntry(
  cmdStr: string,
  startTs: string,
  allowed: boolean,
  outcome: AuditEntry['outcome'],
  durationMs?: number,
): AuditEntry {
  return {
    ts: startTs,
    level: 'audit',
    cmd: cmdStr,
    allowed,
    outcome,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/**
 * Validate and run a read-only CDK CLI command. Returns the command output (or
 * a descriptive error message) as a string suitable for returning to the model.
 */
export async function runCdk(args: string, options: RunCdkOptions = {}): Promise<string> {
  const { audit, regexRedactionRules = [], cwd } = options;
  const startTs = new Date().toISOString();
  const startMs = Date.now();

  const trimmed = args.trim();
  if (!trimmed) return 'Error: no CDK CLI arguments provided.';

  // Ensure lowercase 'cdk' prefix so the validator can parse the subcommand.
  // Use /i for case-insensitivity (CDK → cdk) and (\s|$) instead of \b so
  // 'cdk-real synth' is not mistakenly treated as already having the prefix.
  const cmdStr = /^cdk(\s|$)/i.test(trimmed) ? trimmed.replace(/^cdk/i, 'cdk') : `cdk ${trimmed}`;
  const validation = validateCdkCommand(cmdStr);

  if (!validation) {
    return 'Error: could not parse CDK CLI command.';
  }

  if (!validation.allowed) {
    await writeAudit(cdkAuditEntry(cmdStr, startTs, false, 'blocked'), audit);
    return `${BLOCKED_PREFIX}${validation.reason}`;
  }

  // Tokenize after validation so we exec the same tokens the validator parsed.
  const argv = tokenizeCdkArgs(trimmed);
  if (argv.length === 0) return 'Error: no CDK subcommand provided.';

  try {
    const { stdout, stderr } = await execFileAsync('cdk', argv, {
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      ...(cwd ? { cwd } : {}),
    });

    const rawOutput = stdout.trim() || stderr.trim() || NO_OUTPUT_MESSAGE;
    const output = applyRedaction(rawOutput, regexRedactionRules);
    await writeAudit(cdkAuditEntry(cmdStr, startTs, true, 'ok', Date.now() - startMs), audit);
    return truncate(output);
  } catch (error) {
    const rawDetail = getExecErrorDetail(error);
    const detail = applyRedaction(rawDetail, regexRedactionRules);
    await writeAudit(cdkAuditEntry(cmdStr, startTs, true, 'error', Date.now() - startMs), audit);
    return truncate(`cdk exited with an error:\n${detail}`);
  }
}
