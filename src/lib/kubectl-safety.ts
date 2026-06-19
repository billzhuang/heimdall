/**
 * Read-only safety policy for kubectl commands.
 *
 * Heimdall is an advisory SRE agent: it must never mutate a cluster. This
 * module is the single source of truth for which kubectl subcommands are
 * allowed. It is pure (no I/O) so it can be unit- and property-tested, and is
 * enforced inside the `kubectl` tool before any command is executed.
 */

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

/**
 * Mutating nested verbs for command families in NESTED_ALLOWED_VERBS.
 * Used by isDestructiveCommand to identify state-mutating nested commands.
 */
export const NESTED_DESTRUCTIVE_VERBS: Record<string, readonly string[]> = {
  rollout: ['restart', 'undo', 'pause', 'resume'],
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
const OPTIONS_WITH_VALUE = new Set([
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
  if (parts.length === 0) {
    return result;
  }

  if (parts[0].toLowerCase() !== 'kubectl') {
    return result;
  }

  result.isKubectl = true;

  let skipNext = false;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];

    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (part.startsWith('-')) {
      if (part.includes('=')) {
        continue; // --option=value form, no separate value token
      }
      if (OPTIONS_WITH_VALUE.has(part)) {
        skipNext = true;
      }
      continue;
    }

    result.subcommand = part.toLowerCase();
    result.args = parts.slice(i + 1);
    break;
  }

  return result;
}

/** True when the command is a kubectl invocation that mutates cluster state. */
export function isDestructiveCommand(command: string): boolean {
  const parsed = parseKubectlCommand(command);
  if (!parsed.isKubectl || !parsed.subcommand) {
    return false;
  }
  if (DESTRUCTIVE_KUBECTL_COMMANDS.includes(parsed.subcommand as DestructiveCommand)) {
    return true;
  }
  const nestedDestructive = NESTED_DESTRUCTIVE_VERBS[parsed.subcommand];
  if (nestedDestructive) {
    const verb = parsed.args[0]?.toLowerCase() ?? '';
    return nestedDestructive.includes(verb);
  }
  return false;
}

/**
 * Validate a kubectl command against the read-only policy. Non-kubectl
 * commands are out of scope (the tool only ever runs kubectl), unknown
 * subcommands are denied by default.
 */
export function validateCommand(command: string): CommandValidationResult {
  const parsed = parseKubectlCommand(command);

  if (!parsed.isKubectl) {
    return {
      allowed: false,
      reason: 'Only kubectl commands are permitted by this tool.',
      command: parsed.rawCommand,
      subcommand: null,
    };
  }

  if (!parsed.subcommand) {
    // Bare `kubectl` (prints help) is harmless.
    return {
      allowed: true,
      reason: 'kubectl without subcommand',
      command: parsed.rawCommand,
      subcommand: null,
    };
  }

  if (DESTRUCTIVE_KUBECTL_COMMANDS.includes(parsed.subcommand as DestructiveCommand)) {
    return {
      allowed: false,
      reason: `Destructive command '${parsed.subcommand}' is blocked. Heimdall is read-only — suggest this command to the user to run manually instead.`,
      command: parsed.rawCommand,
      subcommand: parsed.subcommand,
    };
  }

  // Command families that mix read-only and mutating verbs: gate on the nested
  // verb (default-deny within the family).
  const nestedAllowed = NESTED_ALLOWED_VERBS[parsed.subcommand];
  if (nestedAllowed) {
    const verb = parsed.args[0]?.toLowerCase() ?? '';
    if (nestedAllowed.includes(verb)) {
      return {
        allowed: true,
        reason: `Read-only command '${parsed.subcommand} ${verb}' is allowed`,
        command: parsed.rawCommand,
        subcommand: parsed.subcommand,
      };
    }
    const attempted = `${parsed.subcommand} ${verb}`.trim();
    return {
      allowed: false,
      reason: `'${attempted}' is blocked. Only read-only '${parsed.subcommand}' verbs are permitted: ${nestedAllowed.join(', ')}.`,
      command: parsed.rawCommand,
      subcommand: parsed.subcommand,
    };
  }

  if (ALLOWED_KUBECTL_COMMANDS.includes(parsed.subcommand as AllowedCommand)) {
    return {
      allowed: true,
      reason: `Read-only command '${parsed.subcommand}' is allowed`,
      command: parsed.rawCommand,
      subcommand: parsed.subcommand,
    };
  }

  return {
    allowed: false,
    reason: `Unknown kubectl subcommand '${parsed.subcommand}' is blocked. Only explicitly allowed read-only commands are permitted.`,
    command: parsed.rawCommand,
    subcommand: parsed.subcommand,
  };
}
