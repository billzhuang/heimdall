/**
 * Executes read-only AWS CLI commands on behalf of the agent.
 *
 * Design notes:
 * - Commands are tokenized and run with `execFile` (no shell), so shell
 *   metacharacters in model-supplied arguments are inert — no injection surface.
 * - Every command is validated against the read-only policy in aws-safety.ts.
 * - Output is capped to protect the model's context window.
 */
import { execFile } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { validateAwsCommand } from './aws-safety.ts';
import type { AuditConfig } from './kubectl.ts';

const execFileAsync = promisify(execFile);

const EXEC_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024; // 16 MiB
const MAX_RESULT_CHARS = 20_000;

export const NO_OUTPUT_MESSAGE = '(command produced no output)';

interface AuditEntry {
  ts: string;
  level: 'audit';
  cmd: string;
  allowed: boolean;
  durationMs?: number;
  outcome: 'ok' | 'blocked' | 'error';
}

async function writeAudit(entry: AuditEntry, audit: AuditConfig | null | undefined): Promise<void> {
  try {
    if (!audit?.enabled) return;
    const line = JSON.stringify(entry);
    if (audit.file) {
      try {
        await mkdir(dirname(audit.file), { recursive: true });
        await appendFile(audit.file, line + '\n', 'utf8');
      } catch {
        process.stderr.write(line + '\n');
      }
    } else {
      process.stderr.write(line + '\n');
    }
  } catch {
    // Audit failures must never disrupt the main execution path.
  }
}

/** Cap large output so a single read can't blow past the model's context. */
function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS) +
    `\n\n[output truncated at ${MAX_RESULT_CHARS} characters — narrow the query with --query or --filters]`
  );
}

export interface RunAwsCliOptions {
  /** Audit logging config. When enabled, a JSON line is written for every call. */
  audit?: AuditConfig | null;
}

/**
 * Tokenize AWS CLI args similarly to how kubectl args are tokenized.
 * The leading `aws` token is stripped (if present) — callers pass only args.
 */
export function tokenizeAwsArgs(input: string): string[] {
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

  if (tokens.length > 0 && tokens[0].toLowerCase() === 'aws') {
    tokens.shift();
  }
  return tokens;
}

/**
 * Validate and run a read-only AWS CLI command. Returns the command output (or
 * a descriptive error message) as a string suitable for returning to the model.
 */
export async function runAwsCli(args: string, options: RunAwsCliOptions = {}): Promise<string> {
  const { audit } = options;
  const startTs = new Date().toISOString();
  const startMs = Date.now();

  const trimmed = args.trim();
  if (!trimmed) return 'Error: no AWS CLI arguments provided.';

  const argv = tokenizeAwsArgs(trimmed);
  if (argv.length === 0) return 'Error: no AWS CLI subcommand provided.';

  const cmd = `aws ${argv.map((a) => (/[\s'"\\]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(' ')}`;
  const validation = validateAwsCommand(cmd);

  if (!validation) {
    return 'Error: could not parse AWS CLI command.';
  }

  if (!validation.allowed) {
    await writeAudit({ ts: startTs, level: 'audit', cmd, allowed: false, outcome: 'blocked' }, audit);
    return `BLOCKED: ${validation.reason}`;
  }

  try {
    const { stdout, stderr } = await execFileAsync('aws', argv, {
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
    });

    const rawOutput = stdout.trim() || stderr.trim() || NO_OUTPUT_MESSAGE;
    await writeAudit({ ts: startTs, level: 'audit', cmd, allowed: true, durationMs: Date.now() - startMs, outcome: 'ok' }, audit);
    return truncate(rawOutput);
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string };
    const detail = (err.stderr || err.stdout || err.message || String(error)).trim();
    await writeAudit({ ts: startTs, level: 'audit', cmd, allowed: true, durationMs: Date.now() - startMs, outcome: 'error' }, audit);
    return truncate(`aws exited with an error:\n${detail}`);
  }
}
