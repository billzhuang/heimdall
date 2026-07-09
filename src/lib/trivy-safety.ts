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
import { findNextNonOptionToken } from './tokenizer.ts';
import { classifySubcommand } from './subcommand-policy.ts';

/** Trivy scan types that Heimdall permits. */
export const ALLOWED_TRIVY_SCAN_TYPES = ['image', 'fs', 'config', 'sbom'] as const;

/** Trivy subcommands that are always blocked (management / mutating operations). */
export const BLOCKED_TRIVY_SUBCOMMANDS = ['server', 'plugin'] as const;

/** Shell metacharacters that must not appear in a trivy invocation. */
const SHELL_METACHAR_RE = /[|;&<>$`\\]/;

/**
 * Trivy global flags that consume the following token as their value.
 * Only flags in this set cause the parser to skip the next token; all other
 * flags are treated as boolean so that `trivy --debug image nginx:latest`
 * correctly resolves the scan type to "image" rather than "nginx:latest".
 */
export const TRIVY_OPTIONS_WITH_VALUE = new Set([
  '--cache-dir',
  '--cache-backend',
  '--timeout',
  '--format',
  '-f',
  '--severity',
  '-s',
  '--output',
  '-o',
  '--config',
  '-c',
  '--token',
  '--token-header',
  '--db-repository',
  '--java-db-repository',
  '--checks-bundle-repository',
]);

export interface TrivyCommandValidationResult {
  allowed: boolean;
  reason: string;
  /** The scan type token parsed from the command (e.g. "image"). */
  scanType: string | null;
}

/**
 * Find the scan type: the first positional token after "trivy", skipping
 * global flags (--flag / --flag=value). Only flags in TRIVY_OPTIONS_WITH_VALUE
 * consume the next token — all others are boolean and must NOT skip, or
 * boolean flags like --debug would cause the scan type to be skipped
 * (e.g. `trivy --debug image nginx` → scanType=null).
 */
function findScanType(parts: string[]): string | null {
  const idx = findNextNonOptionToken(parts, 1, TRIVY_OPTIONS_WITH_VALUE);
  return idx === -1 ? null : parts[idx].toLowerCase();
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

  const scanType = findScanType(parts);

  if (!scanType) {
    // Bare `trivy` — prints help, harmless.
    return { allowed: true, reason: 'Bare trivy invocation (prints help).', scanType: null };
  }

  const verdict = classifySubcommand(
    (BLOCKED_TRIVY_SUBCOMMANDS as readonly string[]).includes(scanType),
    (ALLOWED_TRIVY_SCAN_TYPES as readonly string[]).includes(scanType),
  );

  if (verdict === 'destructive') {
    return {
      allowed: false,
      reason: `Trivy subcommand '${scanType}' is not permitted. Heimdall only allows passive scans (${ALLOWED_TRIVY_SCAN_TYPES.join(', ')}).`,
      scanType,
    };
  }

  if (verdict === 'unknown') {
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
