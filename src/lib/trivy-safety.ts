/**
 * Read-only safety policy for Trivy commands.
 *
 * Trivy is a passive scanner that never mutates infrastructure. This module
 * validates the command shape before execution so that model-supplied image
 * refs cannot introduce shell-injection payloads or invoke unexpected Trivy
 * modes. It is pure (no I/O) so it can be unit- and property-tested.
 *
 * Policy: default-deny on scan type. Only the four explicitly read-only scan
 * types are allowed; everything else is blocked. Shell metacharacters are
 * also rejected as a defence-in-depth measure even though `execFile` already
 * strips the shell.
 */

/** Trivy scan types that Heimdall permits. */
export const ALLOWED_TRIVY_SCAN_TYPES = ['image', 'fs', 'config', 'sbom'] as const;
export type AllowedTrivyScanType = (typeof ALLOWED_TRIVY_SCAN_TYPES)[number];

/** Trivy subcommands that are always blocked (management / mutating operations). */
export const BLOCKED_TRIVY_SUBCOMMANDS = ['server', 'plugin'] as const;

/** Shell metacharacters that must not appear in a trivy invocation. */
const SHELL_METACHAR_RE = /[|;&<>$`\\]/;

export interface TrivyCommandValidationResult {
  allowed: boolean;
  reason: string;
  /** The scan type token parsed from the command (e.g. "image"). */
  scanType: string | null;
}

/**
 * Validate a trivy command string (including the leading "trivy" token).
 *
 * The function receives the same command string that will be logged in the
 * audit trail so that policy decisions and audit entries always agree.
 */
export function validateTrivyCommand(command: string): TrivyCommandValidationResult {
  const trimmed = command.trim();

  if (!trimmed) {
    return { allowed: false, reason: 'Empty command.', scanType: null };
  }

  if (SHELL_METACHAR_RE.test(trimmed)) {
    return {
      allowed: false,
      reason: 'Shell metacharacters are not permitted in Trivy commands.',
      scanType: null,
    };
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);

  if (parts[0]?.toLowerCase() !== 'trivy') {
    return {
      allowed: false,
      reason: 'Only trivy commands are handled by this tool.',
      scanType: null,
    };
  }

  // Skip global flags (--flag / --flag=value) to find the first positional token.
  let scanType: string | null = null;
  for (let i = 1; i < parts.length; i++) {
    const token = parts[i];
    if (token.startsWith('-')) {
      // Value-taking long flags: --flag=value already consumed; --flag value skips next.
      if (!token.includes('=') && !token.startsWith('--no-')) {
        i++; // skip value token
      }
      continue;
    }
    scanType = token.toLowerCase();
    break;
  }

  if (!scanType) {
    // Bare `trivy` — prints help, harmless.
    return { allowed: true, reason: 'Bare trivy invocation (prints help).', scanType: null };
  }

  if ((BLOCKED_TRIVY_SUBCOMMANDS as readonly string[]).includes(scanType)) {
    return {
      allowed: false,
      reason: `Trivy subcommand '${scanType}' is not permitted. Heimdall only allows passive scans (${ALLOWED_TRIVY_SCAN_TYPES.join(', ')}).`,
      scanType,
    };
  }

  if (!(ALLOWED_TRIVY_SCAN_TYPES as readonly string[]).includes(scanType)) {
    return {
      allowed: false,
      reason: `Unknown Trivy scan type '${scanType}'. Permitted types: ${ALLOWED_TRIVY_SCAN_TYPES.join(', ')}.`,
      scanType,
    };
  }

  return {
    allowed: true,
    reason: `Trivy scan type '${scanType}' is permitted.`,
    scanType,
  };
}
