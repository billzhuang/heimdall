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
 * - When `HEIMDALL_KUBECTL_MOCK` is set to a JSON file path, `runKubectl`
 *   returns fixture output instead of exec'ing kubectl (eval / test mode).
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join as joinPath } from 'node:path';
import { promisify } from 'node:util';
import { validateCommand, applyNamespaceLockdown } from './kubectl-safety.ts';
import { tokenizeShellArgs, buildShellCommand } from './tokenizer.ts';
import { makeTruncate } from './output-truncation.ts';
import { recordCacheHit, recordCacheMiss } from './telemetry.ts';
import { IN_CLUSTER_CONTEXT, isInCluster, parseKubeconfig, resolveKubeconfigPath } from './kubeconfig.ts';
import { redactSecretValues } from './redact.ts';
import { applyRedaction, type CompiledRedactionRule } from './regex-redact.ts';
import { writeAudit, reportBlocked, type AuditConfig, type AuditEntry } from './audit.ts';
import { getExecErrorDetail } from './error-utils.ts';
import { DEFAULT_NO_OUTPUT_MESSAGE } from './cli-exec.ts';
export type { AuditConfig } from './audit.ts';

const execFileAsync = promisify(execFile);

const DEFAULT_CACHE_TTL_SECONDS = 30;
const CACHE_DIR_NAME = 'heimdall-kubectl-cache';
const EXEC_TIMEOUT_MS = 30_000;
const EXEC_TIMEOUT_BUFFER_MS = 5_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024; // 16 MiB
const MAX_RESULT_CHARS = 100_000;
const truncate = makeTruncate(MAX_RESULT_CHARS, 'narrow the query with a selector, field-selector, or jsonpath');

/** In-process cache for parsed eval mock files — avoids redundant disk I/O. */
const evalMockCache = new Map<string, Record<string, string>>();

/** Sentinel returned when a command succeeds but produces no stdout/stderr. */
export const NO_OUTPUT_MESSAGE = DEFAULT_NO_OUTPUT_MESSAGE;


export interface RunKubectlOptions {
  /** Optional cluster context. Injected as `--context=<ctx>` when the
   *  arguments do not already specify one. */
  context?: string;
  /** Override the kubeconfig path (otherwise inherits `KUBECONFIG`). */
  kubeconfig?: string;
  /** Audit logging config. When enabled, a JSON line is written for every call. */
  audit?: AuditConfig | null;
  /** Redact Secret .data / .stringData values from output (default: true). */
  redactSecrets?: boolean;
  /** User-configured regex redaction rules compiled at startup. */
  regexRedactionRules?: CompiledRedactionRule[];
  /** When set, every kubectl call is restricted to this namespace (lockdown mode). */
  lockedNamespace?: string;
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

/**
 * Resolve the per-user cache directory suffix: OS uid when available (POSIX),
 * else the USER/USERNAME env var (Windows), else 'default'.
 * Exported so tests can cover every branch without depending on the host platform.
 */
export function resolveCacheUser(getuid: (() => number) | undefined, env: NodeJS.ProcessEnv): string {
  const uid = typeof getuid === 'function' ? String(getuid()) : undefined;
  return uid ?? env.USER ?? env.USERNAME ?? 'default';
}

/** Per-user cache directory under the configured base (or the OS temp dir). */
function getCacheDir(): string {
  const baseDir = process.env.HEIMDALL_KUBECTL_CACHE_DIR || tmpdir();
  // Isolate per-user so a shared base dir (e.g. /tmp) cannot cause cross-user
  // EACCES write failures or cache poisoning on multi-user hosts.
  const user = resolveCacheUser(process.getuid, process.env);
  return joinPath(baseDir, `${CACHE_DIR_NAME}-${user}`);
}

/**
 * Split a kubectl argument string into argv tokens, honoring single quotes,
 * double quotes and backslash escapes. The leading `kubectl` (if present) is
 * dropped — callers pass only the arguments.
 */
export function tokenizeArgs(input: string): string[] {
  return tokenizeShellArgs(input, 'kubectl');
}

/** True when the argv requests JSON output (`-o json` / `-ojson` / `--output=json`). */
export function isJsonOutput(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--output') {
      return argv[i + 1] === 'json';
    }
    if (a === '-ojson' || a === '-o=json' || a === '--output=json') {
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
 *
 * Named distinctly from `duration.ts`'s `parseDurationMs` — that one parses a
 * different, single-unit grammar (`"500ms"`, `"1.5h"`, `"2d"`) and returns
 * null for the combined k8s form this function accepts (`"1h30m"`), so the
 * two are not interchangeable despite the similar purpose.
 * Exported so tests can cover it without spawning kubectl.
 */
export function parseK8sDurationMs(s: string): number | null {
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
    if (arg === '--timeout' && i + 1 < argv.length) return parseK8sDurationMs(argv[i + 1]);
    if (arg.startsWith('--timeout=')) return parseK8sDurationMs(arg.slice('--timeout='.length));
  }
  return null;
}

/**
 * Match a mock fixture for the given argv.
 *
 * Each key in `mocks` is a space-separated list of tokens. A key matches when
 * every one of its tokens appears (case-insensitive) in the argv set. The
 * most-specific match (most key tokens) wins. Returns null when no key matches.
 *
 * Exported so the eval test suite can exercise this logic independently.
 */
export function matchMock(mocks: Record<string, string>, argv: string[]): string | null {
  if (!mocks || typeof mocks !== 'object') return null;
  const cmdSet = new Set(argv.map(t => t.toLowerCase()));
  let bestKey: string | null = null;
  let bestScore = -1;
  for (const key of Object.keys(mocks)) {
    const keyTokens = key.toLowerCase().split(/\s+/).filter(Boolean);
    if (keyTokens.length === 0) continue;
    if (keyTokens.every(kt => cmdSet.has(kt)) && keyTokens.length > bestScore) {
      bestScore = keyTokens.length;
      bestKey = key;
    }
  }
  return bestKey !== null ? mocks[bestKey] : null;
}

/**
 * Compute the exec timeout for a kubectl invocation.
 *
 * For `kubectl wait`, extend the timeout to match its own `--timeout` so Node
 * doesn't kill the process before kubectl can exit cleanly. Add a buffer for
 * the process to flush output and exit; fall back to EXEC_TIMEOUT_MS for all
 * other subcommands (or when no --timeout is present).
 * Exported so tests can cover it without spawning kubectl.
 */
export function computeExecTimeoutMs(subcommand: string | null, argv: string[]): number {
  if (subcommand === 'wait') {
    const waitMs = getWaitTimeoutMs(argv);
    if (waitMs) return Math.max(EXEC_TIMEOUT_MS, waitMs + EXEC_TIMEOUT_BUFFER_MS);
  }
  return EXEC_TIMEOUT_MS;
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

function applyOutputRedaction(
  text: string,
  argv: string[],
  redactSecrets: boolean,
  rules: CompiledRedactionRule[],
): string {
  return applyRedaction(redactSecrets ? redactSecretValues(text, argv) : text, rules);
}

/** Write a kubectl audit entry, filling in the fields shared by every call site. */
function auditKubectlCall(
  cmd: string,
  startTs: string,
  audit: AuditConfig | null | undefined,
  fields: Omit<AuditEntry, 'ts' | 'level' | 'cmd'>,
): Promise<void> {
  return writeAudit({ ts: startTs, level: 'audit', cmd, ...fields }, audit);
}

/** Argv, environment, and resolution flags needed to exec kubectl. */
interface ExecutionContext {
  argv: string[];
  env: NodeJS.ProcessEnv;
  inCluster: boolean;
  resolvedKubeconfig: string | undefined;
}

/**
 * Resolve the argv/env to exec kubectl with, accounting for in-cluster vs.
 * external kubeconfig execution.
 *
 * When running inside a Kubernetes pod, kubectl reads the mounted service
 * account token automatically. Injecting --context or KUBECONFIG would
 * override that mechanism, so both are skipped when in-cluster.
 */
function resolveExecutionContext(argv: string[], options: RunKubectlOptions): ExecutionContext {
  const inCluster = isInCluster();

  const context = !inCluster ? options.context : undefined;
  if (context && !hasContextFlag(argv)) {
    argv = [`--context=${context}`, ...argv];
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

  return { argv, env, inCluster, resolvedKubeconfig };
}

/**
 * Compute the cache file path for a cacheable `get -o json` call, or null
 * when the call is not eligible for caching.
 *
 * The cache identity must distinguish every input that changes the result:
 * the exact argv (not a space-joined string, which collides across quoting
 * variants), the kubeconfig file, and the effective cluster context. When no
 * --context flag is present the active context comes from the kubeconfig's
 * current-context, so it is included to avoid serving cluster A's data for
 * cluster B after a context switch.
 */
async function resolveCacheFile(
  argv: string[],
  subcommand: string | null,
  execCtx: ExecutionContext,
): Promise<string | null> {
  if (!isCacheEnabled() || subcommand !== 'get' || !isJsonOutput(argv)) return null;

  let effectiveContext = '';
  if (!hasContextFlag(argv)) {
    if (execCtx.inCluster) {
      effectiveContext = IN_CLUSTER_CONTEXT;
    } else {
      const cfg = await parseKubeconfig(resolveKubeconfigPath(execCtx.resolvedKubeconfig));
      effectiveContext = cfg?.currentContext ?? '';
    }
  }
  const identity = JSON.stringify({ argv, kubeconfig: execCtx.env.KUBECONFIG ?? '', effectiveContext });
  const hash = createHash('sha256').update(identity).digest('hex');
  return joinPath(getCacheDir(), `${hash}.json`);
}

/**
 * Validate and run a read-only kubectl command. Returns the command output (or
 * a descriptive error message) as a string suitable for returning to the model.
 */
export async function runKubectl(args: string, options: RunKubectlOptions = {}): Promise<string> {
  const { audit, redactSecrets = true, regexRedactionRules = [] } = options;
  const startTs = new Date().toISOString();
  const startMs = Date.now();

  const trimmed = args.trim();
  if (!trimmed) {
    return 'Error: no kubectl arguments provided.';
  }

  // Tokenize first so validation and execution agree on the command. The
  // model may or may not include a leading "kubectl" in `args`; tokenizeArgs
  // drops it, and we validate the exact argv we are about to execute.
  let argv = tokenizeArgs(trimmed);
  if (argv.length === 0) {
    return 'Error: no kubectl subcommand provided.';
  }

  const cmd = buildShellCommand('kubectl', argv);
  const validation = validateCommand(cmd);
  if (!validation.allowed) {
    return reportBlocked(cmd, startTs, audit, validation.reason);
  }

  // Enforce namespace lockdown: block cross-namespace reads and inject the
  // locked namespace when no -n/--namespace flag is present.
  // Use typeof check (not truthiness) so an empty string doesn't silently bypass.
  if (typeof options.lockedNamespace === 'string') {
    const lockdown = applyNamespaceLockdown(argv, options.lockedNamespace);
    if (lockdown.blocked) {
      return reportBlocked(cmd, startTs, audit, lockdown.reason ?? '');
    }
    argv = lockdown.argv;
  }

  // Eval mock mode: return fixture output instead of exec'ing kubectl.
  const evalMockFile = process.env.HEIMDALL_KUBECTL_MOCK;
  if (evalMockFile) {
    try {
      let mocks = evalMockCache.get(evalMockFile);
      if (!mocks) {
        const raw = await readFile(evalMockFile, 'utf8');
        mocks = JSON.parse(raw) as Record<string, string>;
        evalMockCache.set(evalMockFile, mocks);
      }
      const hit = matchMock(mocks, argv);
      const result = hit ?? `(eval: no mock fixture for: ${argv.join(' ')})`;
      await auditKubectlCall(cmd, startTs, audit, { context: options.context, allowed: true, cached: false, durationMs: 0, outcome: 'ok' });
      return result;
    } catch (err) {
      return `(eval mock error: ${String(err)})`;
    }
  }

  const execCtx = resolveExecutionContext(argv, options);
  argv = execCtx.argv;
  const { env } = execCtx;

  // Serve JSON `get` reads from the short-TTL cache when possible.
  const cacheFile = await resolveCacheFile(argv, validation.subcommand, execCtx);
  if (cacheFile) {
    const cached = await readFromCache(cacheFile, getCacheTtlSeconds());
    if (cached !== null) {
      // Apply redaction on cache reads too: cache entries written before
      // redaction was enabled (or while it was temporarily disabled) may
      // contain raw secret values.
      const safeOutput = applyOutputRedaction(cached, argv, redactSecrets, regexRedactionRules);
      await auditKubectlCall(cmd, startTs, audit, { context: options.context, allowed: true, cached: true, outcome: 'ok' });
      recordCacheHit();
      return truncate(safeOutput);
    }
    recordCacheMiss();
  }

  const execTimeoutMs = computeExecTimeoutMs(validation.subcommand, argv);

  try {
    const { stdout, stderr } = await execFileAsync('kubectl', argv, {
      encoding: 'utf8',
      env,
      timeout: execTimeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
    });

    const rawOutput = stdout.trim() || stderr.trim() || NO_OUTPUT_MESSAGE;
    const output = applyOutputRedaction(rawOutput, argv, redactSecrets, regexRedactionRules);

    if (cacheFile && stdout) {
      try {
        await mkdir(dirname(cacheFile), { recursive: true });
        // Cache the redacted output so cache hits are also safe.
        await writeFile(cacheFile, output, 'utf8');
      } catch {
        // Caching is best-effort; ignore write failures.
      }
    }

    await auditKubectlCall(cmd, startTs, audit, { context: options.context, allowed: true, cached: false, durationMs: Date.now() - startMs, outcome: 'ok' });
    return truncate(output);
  } catch (error) {
    const rawDetail = getExecErrorDetail(error);
    const detail = applyOutputRedaction(rawDetail, argv, redactSecrets, regexRedactionRules);
    await auditKubectlCall(cmd, startTs, audit, { context: options.context, allowed: true, cached: false, durationMs: Date.now() - startMs, outcome: 'error' });
    return truncate(`kubectl exited with an error:\n${detail}`);
  }
}
