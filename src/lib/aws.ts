/**
 * Executes read-only AWS CLI commands on behalf of the agent.
 *
 * Design notes:
 * - Commands are tokenized and run with `execFile` (no shell), so shell
 *   metacharacters in model-supplied arguments are inert — no injection surface.
 * - Every command is validated against the read-only policy in aws-safety.ts.
 * - Output is capped to protect the model's context window.
 */
import { validateAwsCommand } from './aws-safety.ts';
import { tokenizeShellArgs, buildShellCommand } from './tokenizer.ts';
import { makeTruncate } from './output-truncation.ts';
import { reportBlocked, type AuditConfig } from './audit.ts';
import { execAndReport, DEFAULT_NO_OUTPUT_MESSAGE } from './cli-exec.ts';
import type { CompiledRedactionRule } from './regex-redact.ts';

const EXEC_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024; // 16 MiB
const MAX_RESULT_CHARS = 20_000;
const truncate = makeTruncate(MAX_RESULT_CHARS, 'narrow the query with --query or --filters');

export const NO_OUTPUT_MESSAGE = DEFAULT_NO_OUTPUT_MESSAGE;

export interface RunAwsCliOptions {
  /** Audit logging config. When enabled, a JSON line is written for every call. */
  audit?: AuditConfig | null;
  /** User-configured regex redaction rules compiled at startup. */
  regexRedactionRules?: CompiledRedactionRule[];
}

/**
 * Tokenize AWS CLI args. The leading `aws` token is stripped (if present) —
 * callers can pass either `"aws ec2 describe-instances"` or `"ec2 describe-instances"`.
 */
export function tokenizeAwsArgs(input: string): string[] {
  return tokenizeShellArgs(input, 'aws');
}

/**
 * Validate and run a read-only AWS CLI command. Returns the command output (or
 * a descriptive error message) as a string suitable for returning to the model.
 */
export async function runAwsCli(args: string, options: RunAwsCliOptions = {}): Promise<string> {
  const { audit, regexRedactionRules = [] } = options;
  const startTs = new Date().toISOString();
  const startMs = Date.now();

  const trimmed = args.trim();
  if (!trimmed) return 'Error: no AWS CLI arguments provided.';

  const argv = tokenizeAwsArgs(trimmed);
  if (argv.length === 0) return 'Error: no AWS CLI subcommand provided.';

  const cmd = buildShellCommand('aws', argv);
  const validation = validateAwsCommand(cmd);

  if (!validation) {
    return 'Error: could not parse AWS CLI command.';
  }

  if (!validation.allowed) {
    return reportBlocked(cmd, startTs, audit, validation.reason);
  }

  return execAndReport({
    bin: 'aws',
    argv,
    cmd,
    startTs,
    startMs,
    execOptions: { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
    audit,
    regexRedactionRules,
    noOutputMessage: NO_OUTPUT_MESSAGE,
    truncate,
  });
}
