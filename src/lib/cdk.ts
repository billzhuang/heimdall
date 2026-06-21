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
import { validateCdkCommand } from './cdk-safety.ts';
import { writeAudit, type AuditConfig } from './audit.ts';
import { BLOCKED_PREFIX } from './harness.ts';
import { applyRedaction, type CompiledRedactionRule } from './regex-redact.ts';

const execFileAsync = promisify(execFile);

const EXEC_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024; // 16 MiB
const MAX_RESULT_CHARS = 20_000;

export const NO_OUTPUT_MESSAGE = '(command produced no output)';

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS) +
    `\n\n[output truncated at ${MAX_RESULT_CHARS} characters — narrow the query with stack selectors or --filter]`
  );
}

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
 * Tokenize CDK CLI args. Strips the leading `cdk` token if present.
 * Uses shell-like tokenization without invoking a shell.
 */
export function tokenizeCdkArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else if (ch === '\\' && i + 1 < input.length && (input[i + 1] === '"' || input[i + 1] === '\\')) {
        current += input[++i];
      } else current += ch;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasToken = true;
    } else if (ch === '"') {
      inDouble = true;
      hasToken = true;
    } else if (ch === '\\' && i + 1 < input.length) {
      current += input[++i];
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(current);

  // Strip leading "cdk" if present.
  if (tokens.length > 0 && tokens[0].toLowerCase() === 'cdk') {
    tokens.shift();
  }
  return tokens;
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

  const argv = tokenizeCdkArgs(trimmed);
  if (argv.length === 0) return 'Error: no CDK subcommand provided.';

  const cmd = `cdk ${argv.map((a) => (/[\s'"\\]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(' ')}`;
  const validation = validateCdkCommand(cmd);

  if (!validation) {
    return 'Error: could not parse CDK CLI command.';
  }

  if (!validation.allowed) {
    await writeAudit({ ts: startTs, level: 'audit', cmd, allowed: false, outcome: 'blocked' }, audit);
    return `${BLOCKED_PREFIX}${validation.reason}`;
  }

  try {
    const { stdout, stderr } = await execFileAsync('cdk', argv, {
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      ...(cwd ? { cwd } : {}),
    });

    const rawOutput = stdout.trim() || stderr.trim() || NO_OUTPUT_MESSAGE;
    const output = applyRedaction(rawOutput, regexRedactionRules);
    await writeAudit({ ts: startTs, level: 'audit', cmd, allowed: true, durationMs: Date.now() - startMs, outcome: 'ok' }, audit);
    return truncate(output);
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string };
    const rawDetail = (err.stderr || err.stdout || err.message || String(error)).trim();
    const detail = applyRedaction(rawDetail, regexRedactionRules);
    await writeAudit({ ts: startTs, level: 'audit', cmd, allowed: true, durationMs: Date.now() - startMs, outcome: 'error' }, audit);
    return truncate(`cdk exited with an error:\n${detail}`);
  }
}
