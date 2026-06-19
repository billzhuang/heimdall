/**
 * Executes read-only kubectl commands on behalf of the agent.
 *
 * Design notes:
 * - Commands are tokenized and run with `execFile` (no shell), so shell
 *   metacharacters in model-supplied arguments are inert — there is no
 *   injection surface and nothing pipes into `rm`, `curl`, etc.
 * - Every command is validated against the read-only policy in
 *   `kubectl-safety.ts` before it runs.
 * - `kubectl get ... -o json` responses are cached on disk for a short TTL to
 *   avoid hammering the API server during tight diagnostic loops.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join as joinPath } from 'node:path';
import { promisify } from 'node:util';
import { validateCommand } from './kubectl-safety.ts';
import { IN_CLUSTER_CONTEXT, isInCluster, parseKubeconfig, resolveKubeconfigPath } from './kubeconfig.ts';

const execFileAsync = promisify(execFile);

const DEFAULT_CACHE_TTL_SECONDS = 30;
const CACHE_DIR_NAME = 'heimdall-kubectl-cache';
const EXEC_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024; // 16 MiB
const MAX_RESULT_CHARS = 100_000;

/** Sentinel returned when a command succeeds but produces no stdout/stderr. */
export const NO_OUTPUT_MESSAGE = '(command produced no output)';

export interface AuditConfig {
  enabled: boolean;
  /** Path to a JSONL file. Omit (or set null) to write to stderr. */
  file?: string | null;
}

interface AuditEntry {
  ts: string;
  level: 'audit';
  cmd: string;
  context?: string;
  allowed: boolean;
  cached?: boolean;
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

export interface RunKubectlOptions {
  /** Optional cluster context. Injected as `--context=<ctx>` when the
   *  arguments do not already specify one. */
  context?: string;
  /** Override the kubeconfig path (otherwise inherits `KUBECONFIG`). */
  kubeconfig?: string;
  /** Audit logging config. When enabled, a JSON line is written for every call. */
  audit?: AuditConfig | null;
}

/** Whether the on-disk JSON cache is enabled (disabled by `HEIMDALL_KUBECTL_CACHE=0`). */
function isCacheEnabled(): boolean {
  return process.env.HEIMDALL_KUBECTL_CACHE !== '0';
}

/** Cache TTL in seconds from `HEIMDALL_KUBECTL_CACHE_TTL`, falling back to the default. */
function getCacheTtlSeconds(): number {
  const raw = process.env.HEIMDALL_KUBECTL_CACHE_TTL;
  if (!raw) return DEFAULT_CACHE_TTL_SECONDS;
  const ttl = Number.parseInt(raw, 10);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_CACHE_TTL_SECONDS;
}

/** Per-user cache directory under the configured base (or the OS temp dir). */
function getCacheDir(): string {
  const baseDir = process.env.HEIMDALL_KUBECTL_CACHE_DIR || tmpdir();
  // Isolate per-user so a shared base dir (e.g. /tmp) cannot cause cross-user
  // EACCES write failures or cache poisoning on multi-user hosts.
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : undefined;
  const user = uid ?? process.env.USER ?? process.env.USERNAME ?? 'default';
  return joinPath(baseDir, `${CACHE_DIR_NAME}-${user}`);
}

/**
 * Split a kubectl argument string into argv tokens, honoring single quotes,
 * double quotes and backslash escapes. The leading `kubectl` (if present) is
 * dropped — callers pass only the arguments.
 */
export function tokenizeArgs(input: string): string[] {
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

  if (tokens.length > 0 && tokens[0].toLowerCase() === 'kubectl') {
    tokens.shift();
  }
  return tokens;
}

/** True when the argv requests JSON output (`-o json` / `--output=json`). */
export function isJsonOutput(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--output') {
      return argv[i + 1] === 'json';
    }
    if (a === '-o=json' || a === '--output=json') {
      return true;
    }
  }
  return false;
}

/** True when the argv already specifies a `--context` flag. */
function hasContextFlag(argv: string[]): boolean {
  return argv.some((a) => a === '--context' || a.startsWith('--context='));
}

/**
 * Parse a Kubernetes/Go duration string (e.g. "30s", "2m", "1h30m") to milliseconds.
 * Returns null for unrecognised formats; 0-ms durations also return null.
 * Exported so tests can cover it without spawning kubectl.
 */
export function parseDurationMs(s: string): number | null {
  if (!s) return null;
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || m[0] === '') return null;
  const h = parseInt(m[1] ?? '0', 10) || 0;
  const min = parseInt(m[2] ?? '0', 10) || 0;
  const sec = parseInt(m[3] ?? '0', 10) || 0;
  const total = h * 3600_000 + min * 60_000 + sec * 1_000;
  return total > 0 ? total : null;
}

/**
 * Extract the --timeout flag value (in ms) from a kubectl wait argv.
 * Returns null when no --timeout is present.
 * Exported so tests can cover it without spawning kubectl.
 */
export function getWaitTimeoutMs(argv: string[]): number | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--timeout' && i + 1 < argv.length) return parseDurationMs(argv[i + 1]);
    if (arg.startsWith('--timeout=')) return parseDurationMs(arg.slice('--timeout='.length));
  }
  return null;
}

/** Cap very large output so a single read can't blow past the model's context. */
function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS) +
    `\n\n[output truncated at ${MAX_RESULT_CHARS} characters — narrow the query with a selector, field-selector, or jsonpath]`
  );
}

/** Return the cached contents if the file exists and is younger than the TTL, else null. */
async function readFromCache(cacheFile: string, ttlSeconds: number): Promise<string | null> {
  try {
    const info = await stat(cacheFile);
    const ageSeconds = (Date.now() - info.mtimeMs) / 1000;
    if (ageSeconds < ttlSeconds) {
      return await readFile(cacheFile, 'utf8');
    }
  } catch {
    // Cache miss / unreadable — fall through to a fresh execution.
  }
  return null;
}

/**
 * Validate and run a read-only kubectl command. Returns the command output (or
 * a descriptive error message) as a string suitable for returning to the model.
 */
export async function runKubectl(args: string, options: RunKubectlOptions = {}): Promise<string> {
  const { audit } = options;
  const startTs = new Date().toISOString();
  const startMs = Date.now();

  const trimmed = args.trim();
  if (!trimmed) {
    return 'Error: no kubectl arguments provided.';
  }

  // Tokenize first so validation and execution agree on the command. The
  // model may or may not include a leading "kubectl" in `args`; tokenizeArgs
  // drops it, and we validate the exact argv we are about to execute.
  const argv = tokenizeArgs(trimmed);
  if (argv.length === 0) {
    return 'Error: no kubectl subcommand provided.';
  }

  const cmd = `kubectl ${argv.map((a) => (/[\s'"\\]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(' ')}`;
  const validation = validateCommand(cmd);
  if (!validation.allowed) {
    await writeAudit({ ts: startTs, level: 'audit', cmd, allowed: false, outcome: 'blocked' }, audit);
    return `BLOCKED: ${validation.reason}`;
  }

  // When running inside a Kubernetes pod, kubectl reads the mounted service account
  // token automatically. Injecting --context or KUBECONFIG would override that
  // mechanism, so we skip both when in-cluster.
  const inCluster = isInCluster();

  const context = !inCluster ? options.context : undefined;
  if (context && !hasContextFlag(argv)) {
    argv.unshift(`--context=${context}`);
  }

  const resolvedKubeconfig = !inCluster ? options.kubeconfig : undefined;

  const env = { ...process.env };
  if (inCluster) {
    // In-cluster: kubectl uses the mounted service account token automatically.
    // Do not set KUBECONFIG — it would override the in-cluster config.
    delete env.KUBECONFIG;
  } else if (resolvedKubeconfig) {
    env.KUBECONFIG = resolvedKubeconfig;
  }

  // Serve JSON `get` reads from the short-TTL cache when possible.
  const parsed = validation.subcommand;
  const cacheable = isCacheEnabled() && parsed === 'get' && isJsonOutput(argv);
  let cacheFile: string | null = null;
  if (cacheable) {
    // The cache identity must distinguish every input that changes the result:
    // the exact argv (not a space-joined string, which collides across quoting
    // variants), the kubeconfig file, and the effective cluster context. When
    // no --context flag is present the active context comes from the
    // kubeconfig's current-context, so include it to avoid serving cluster A's
    // data for cluster B after a context switch.
    let effectiveContext = '';
    if (!hasContextFlag(argv)) {
      if (inCluster) {
        effectiveContext = IN_CLUSTER_CONTEXT;
      } else {
        // resolvedKubeconfig was already computed above; reuse it for consistency.
        const cfg = await parseKubeconfig(resolveKubeconfigPath(resolvedKubeconfig));
        effectiveContext = cfg?.currentContext ?? '';
      }
    }
    const identity = JSON.stringify({ argv, kubeconfig: env.KUBECONFIG ?? '', effectiveContext });
    const hash = createHash('sha256').update(identity).digest('hex');
    cacheFile = joinPath(getCacheDir(), `${hash}.json`);
    const cached = await readFromCache(cacheFile, getCacheTtlSeconds());
    if (cached !== null) {
      await writeAudit({ ts: startTs, level: 'audit', cmd, context: options.context, allowed: true, cached: true, outcome: 'ok' }, audit);
      return truncate(cached);
    }
  }

  // For `kubectl wait`, extend the exec timeout to match --timeout so Node
  // doesn't kill the process before kubectl can exit cleanly. Add a 5 s buffer
  // for the process to flush output and exit; fall back to EXEC_TIMEOUT_MS for
  // all other subcommands (or when no --timeout is present).
  const EXEC_TIMEOUT_BUFFER_MS = 5_000;
  const execTimeoutMs = (() => {
    if (validation.subcommand === 'wait') {
      const waitMs = getWaitTimeoutMs(argv);
      if (waitMs) return Math.max(EXEC_TIMEOUT_MS, waitMs + EXEC_TIMEOUT_BUFFER_MS);
    }
    return EXEC_TIMEOUT_MS;
  })();

  try {
    const { stdout, stderr } = await execFileAsync('kubectl', argv, {
      encoding: 'utf8',
      env,
      timeout: execTimeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
    });

    const output = stdout.trim() || stderr.trim() || NO_OUTPUT_MESSAGE;

    if (cacheFile && stdout) {
      try {
        await mkdir(dirname(cacheFile), { recursive: true });
        await writeFile(cacheFile, stdout, 'utf8');
      } catch {
        // Caching is best-effort; ignore write failures.
      }
    }

    await writeAudit({ ts: startTs, level: 'audit', cmd, context: options.context, allowed: true, cached: false, durationMs: Date.now() - startMs, outcome: 'ok' }, audit);
    return truncate(output);
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string };
    const detail = (err.stderr || err.stdout || err.message || String(error)).trim();
    await writeAudit({ ts: startTs, level: 'audit', cmd, context: options.context, allowed: true, cached: false, durationMs: Date.now() - startMs, outcome: 'error' }, audit);
    return truncate(`kubectl exited with an error:\n${detail}`);
  }
}
