/**
 * Read-only safety policy for kubectl commands.
 *
 * Heimdall is an advisory SRE agent: it must never mutate a cluster. This
 * module is the single source of truth for which kubectl subcommands are
 * allowed. It is pure (no I/O) so it can be unit- and property-tested, and is
 * enforced inside the `kubectl` tool before any command is executed.
 */
import { findNextNonOptionToken } from './tokenizer.ts';

/**
 * kubectl subcommands that modify cluster state, execute code inside a
 * container, or exfiltrate data. These are always blocked.
 */
export const DESTRUCTIVE_KUBECTL_COMMANDS = [
  'apply',
  'create',
  'delete',
  'patch',
  'edit',
  'replace',
  'scale',
  'drain',
  'cordon',
  'uncordon',
  'taint',
  // Commands that can execute arbitrary code or exfiltrate data
  'exec',
  'port-forward',
  'attach',
  'cp',
  'debug',
] as const;

/**
 * Explicitly allowed read-only kubectl subcommands. Anything not on this list
 * is blocked by default (default-deny).
 *
 * Note: `auth` and `config` are intentionally NOT here. They are command
 * families that mix read-only and mutating verbs (`auth reconcile` writes RBAC;
 * `config set-context`/`use-context` mutate the kubeconfig). They are gated by
 * the nested allow-list below instead.
 */
export const ALLOWED_KUBECTL_COMMANDS = [
  'get',
  'describe',
  'logs',
  'top',
  'explain',
  'api-resources',
  'api-versions',
  'version',
  'cluster-info',
  // Server-side dry-run: compares live state against a manifest, no writes.
  // In practice the agent can only use this with inline manifests passed via -f.
  'diff',
  // Read-only event listing (kubectl ≥ 1.26). --watch streams indefinitely;
  // the tool's exec timeout will kill it, so no special flag blocking is needed.
  'events',
  // Polls until a resource condition is met and exits; never mutates state.
  // Long-running invocations are killed by EXEC_TIMEOUT_MS before they can hang.
  'wait',
] as const;

/**
 * Read-only nested verbs allowed for command families that also contain
 * mutating verbs. The family's first argument must be on this list; everything
 * else in the family is denied (default-deny).
 */
export const NESTED_ALLOWED_VERBS: Record<string, readonly string[]> = {
  auth: ['can-i', 'whoami'],
  // rollout mixes read-only verbs (status, history) with mutating ones (restart, undo, pause, resume).
  rollout: ['status', 'history'],
};

export type DestructiveCommand = (typeof DESTRUCTIVE_KUBECTL_COMMANDS)[number];
export type AllowedCommand = (typeof ALLOWED_KUBECTL_COMMANDS)[number];

/** Result of parsing a kubectl command string. */
export interface ParsedKubectlCommand {
  isKubectl: boolean;
  subcommand: string | null;
  args: string[];
  rawCommand: string;
}

/** Result of validating a kubectl command against the read-only policy. */
export interface CommandValidationResult {
  allowed: boolean;
  reason: string;
  command: string;
  subcommand: string | null;
}

/**
 * Global options that consume the following token as their value. This must
 * include every value-taking kubectl global flag to prevent bypass attacks
 * such as `kubectl --v 5 delete pods`. Allocated once at module load.
 */
export const OPTIONS_WITH_VALUE = new Set([
  '-n', '--namespace',
  '-c', '--container',
  '-l', '--selector',
  '-f', '--filename',
  '-o', '--output',
  '--as',
  '--as-group',
  '--as-uid',
  '--cache-dir',
  '--certificate-authority',
  '--client-certificate',
  '--client-key',
  '--cluster',
  '--context',
  '--kubeconfig',
  '--log-flush-frequency',
  '--password',
  '--profile',
  '--profile-output',
  '--request-timeout',
  '--server', '-s',
  '--tls-server-name',
  '--token',
  '--user',
  '--username',
  '--v', '-v',
  '--vmodule',
]);

/**
 * Parse a command string to extract the kubectl subcommand. Handles global
 * flags that take a value (e.g. `kubectl --context=prod -n kube-system get`)
 * so that an attacker cannot smuggle a destructive subcommand past the parser
 * with something like `kubectl --v 5 delete pods`.
 */
export function parseKubectlCommand(command: string): ParsedKubectlCommand {
  const trimmed = command.trim();
  const result: ParsedKubectlCommand = {
    isKubectl: false,
    subcommand: null,
    args: [],
    rawCommand: trimmed,
  };

  if (!trimmed) {
    return result;
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts[0].toLowerCase() !== 'kubectl') {
    return result;
  }

  result.isKubectl = true;

  const subIndex = findNextNonOptionToken(parts, 1, OPTIONS_WITH_VALUE);
  if (subIndex !== -1) {
    result.subcommand = parts[subIndex].toLowerCase();
    result.args = parts.slice(subIndex + 1);
  }

  return result;
}

/** Result of applying namespace lockdown to a tokenized argv. */
export type NamespaceLockdownResult =
  | { blocked: true; reason: string; argv: string[] }
  | { blocked: false; argv: string[] };

/**
 * Enforce namespace lockdown on a tokenized kubectl argv.
 *
 * Handles all flag forms that kubectl/pflag accepts:
 * - Long:      `--all-namespaces`, `--namespace <val>`, `--namespace=<val>`
 * - Shorthand: `-A`, `-n <val>`, `-n=<val>`, `-n<val>` (attached), `-An` (grouped)
 *
 * Collects *every* namespace specified across all flags and blocks if any
 * differs from the locked namespace, so mixed-flag bypass attempts are caught.
 *
 * Pure function: no I/O.
 */
export function applyNamespaceLockdown(argv: string[], lockedNs: string): NamespaceLockdownResult {
  let hasNamespaceFlag = false;
  const specifiedNamespaces: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    // Block --all-namespaces in all forms: bare, boolean (--all-namespaces=true/1), etc.
    if (arg === '--all-namespaces' || arg.startsWith('--all-namespaces=')) {
      return {
        blocked: true,
        reason: `namespace lockdown is active — '--all-namespaces' is not allowed; only namespace '${lockedNs}' is accessible`,
        argv,
      };
    }

    if (arg.startsWith('--')) {
      if (arg === '--namespace') {
        hasNamespaceFlag = true;
        specifiedNamespaces.push(i + 1 < argv.length ? argv[++i] : '');
      } else if (arg.startsWith('--namespace=')) {
        hasNamespaceFlag = true;
        specifiedNamespaces.push(arg.slice('--namespace='.length));
      }
    } else if (arg.startsWith('-') && arg !== '-') {
      // Split on first `=` to separate the flag cluster from an attached value.
      const eqIdx = arg.indexOf('=');
      const flags = (eqIdx === -1 ? arg : arg.slice(0, eqIdx)).slice(1);
      const eqValue = eqIdx === -1 ? undefined : arg.slice(eqIdx + 1);

      // Any flag cluster containing 'A' triggers all-namespaces.
      if (flags.includes('A')) {
        return {
          blocked: true,
          reason: `namespace lockdown is active — '-A' is not allowed; only namespace '${lockedNs}' is accessible`,
          argv,
        };
      }

      const nIdx = flags.indexOf('n');
      if (nIdx !== -1) {
        hasNamespaceFlag = true;
        if (nIdx < flags.length - 1) {
          // `-n<value>` form: characters after 'n' are the namespace value.
          specifiedNamespaces.push(flags.slice(nIdx + 1) + (eqValue !== undefined ? `=${eqValue}` : ''));
        } else if (eqValue !== undefined) {
          // `-n=<value>` form.
          specifiedNamespaces.push(eqValue);
        } else if (i + 1 < argv.length) {
          // `-n <value>` form: consume the next token.
          specifiedNamespaces.push(argv[++i]);
        } else {
          specifiedNamespaces.push('');
        }
      }
    }
  }

  for (const ns of specifiedNamespaces) {
    if (ns !== lockedNs) {
      return {
        blocked: true,
        reason: `namespace lockdown is active — only '${lockedNs}' is accessible; '${ns}' is not allowed`,
        argv,
      };
    }
  }

  if (!hasNamespaceFlag) {
    return { blocked: false, argv: [...argv, `--namespace=${lockedNs}`] };
  }

  return { blocked: false, argv };
}

/**
 * Build a validation result for `parsed`. `subcommand` defaults to
 * `parsed.subcommand`; pass `null` explicitly for the two cases (not-kubectl,
 * no-subcommand) where the parsed subcommand shouldn't be echoed back.
 */
function makeResult(
  allowed: boolean,
  reason: string,
  parsed: ParsedKubectlCommand,
  subcommand: string | null = parsed.subcommand,
): CommandValidationResult {
  return { allowed, reason, command: parsed.rawCommand, subcommand };
}

/**
 * Validate a kubectl command against the read-only policy. Non-kubectl
 * commands are out of scope (the tool only ever runs kubectl), unknown
 * subcommands are denied by default.
 */
export function validateCommand(command: string): CommandValidationResult {
  const parsed = parseKubectlCommand(command);

  if (!parsed.isKubectl) {
    return makeResult(false, 'Only kubectl commands are permitted by this tool.', parsed, null);
  }

  if (!parsed.subcommand) {
    // Bare `kubectl` (prints help) is harmless.
    return makeResult(true, 'kubectl without subcommand', parsed, null);
  }

  if (DESTRUCTIVE_KUBECTL_COMMANDS.includes(parsed.subcommand as DestructiveCommand)) {
    return makeResult(
      false,
      `Destructive command '${parsed.subcommand}' is blocked. Heimdall is read-only — suggest this command to the user to run manually instead.`,
      parsed,
    );
  }

  // Block bare stdin reads that would cause execFile to hang waiting for input.
  // "-f-" and "--filename=-" are always blocked (no value follows the dash).
  // "-f -" / "--filename -" are only blocked when "-" is the final token; when
  // extra tokens follow (e.g. a heredoc marker like "<<EOF"), kubectl will fail
  // with an argument error rather than blocking on stdin indefinitely.
  for (let i = 0; i < parsed.args.length; i++) {
    const arg = parsed.args[i];
    if (arg === '-f-' || arg === '--filename=-') {
      return makeResult(false, 'Reading from stdin via "-" is not supported and would cause the command to hang.', parsed);
    }
    if (
      (arg === '-f' || arg === '--filename') &&
      parsed.args[i + 1] === '-' &&
      i + 2 >= parsed.args.length
    ) {
      return makeResult(false, 'Reading from stdin via "-" is not supported and would cause the command to hang.', parsed);
    }
  }

  // Command families that mix read-only and mutating verbs: gate on the nested
  // verb (default-deny within the family).
  const nestedAllowed = NESTED_ALLOWED_VERBS[parsed.subcommand];
  if (nestedAllowed) {
    const verb = parsed.args[0]?.toLowerCase() ?? '';
    if (nestedAllowed.includes(verb)) {
      return makeResult(true, `Read-only command '${parsed.subcommand} ${verb}' is allowed`, parsed);
    }
    const attempted = `${parsed.subcommand} ${verb}`.trim();
    return makeResult(
      false,
      `'${attempted}' is blocked. Only read-only '${parsed.subcommand}' verbs are permitted: ${nestedAllowed.join(', ')}.`,
      parsed,
    );
  }

  if (ALLOWED_KUBECTL_COMMANDS.includes(parsed.subcommand as AllowedCommand)) {
    return makeResult(true, `Read-only command '${parsed.subcommand}' is allowed`, parsed);
  }

  return makeResult(
    false,
    `Unknown kubectl subcommand '${parsed.subcommand}' is blocked. Only explicitly allowed read-only commands are permitted.`,
    parsed,
  );
}
