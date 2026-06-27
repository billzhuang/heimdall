/**
 * Redacts Kubernetes Secret .data and .stringData values from kubectl output.
 *
 * Pure (no I/O). Applied in runKubectl after execution, before caching and
 * returning, so secret values never reach the model regardless of prompt
 * instructions.
 */
import * as yaml from 'js-yaml';
import { OPTIONS_WITH_VALUE } from './kubectl-safety.ts';

export const REDACTED_FORMAT_MESSAGE =
  'Secret values cannot be safely extracted in this output format. ' +
  'Use -o json or -o yaml to inspect Secrets — values will be redacted automatically.';

/**
 * Detect the kubectl output format from the argv token list.
 * Recognises both attached forms (`-ojson`, `-o=json`, `--output=json`) and
 * separated forms (`-o json`, `--output yaml`). Returns 'other' when an -o flag
 * is present but specifies neither json nor yaml, or 'other' when no -o flag exists.
 */
export function detectFormat(argv: string[]): 'json' | 'yaml' | 'other' {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-ojson' || a === '-o=json' || a === '--output=json') return 'json';
    if (a === '-oyaml' || a === '-o=yaml' || a === '--output=yaml') return 'yaml';
    if ((a === '-o' || a === '--output') && i + 1 < argv.length) {
      const val = argv[i + 1];
      if (val === 'json') return 'json';
      if (val === 'yaml') return 'yaml';
      return 'other';
    }
  }
  return 'other';
}

// Reuse the authoritative set from kubectl-safety.ts so the two parsers stay in sync.
const FLAGS_CONSUMING_NEXT = OPTIONS_WITH_VALUE;

/**
 * Return true when a single resource-type token refers to a Kubernetes Secret.
 * Handles singular/plural forms and slash-prefixed name forms (e.g. `secret/my-creds`).
 * Also handles comma-separated resource lists where secret appears alongside other kinds
 * (e.g. `secret,configmap`).
 */
export function isSecretResource(token: string): boolean {
  const lower = token.toLowerCase();
  return lower.split(',').some(
    (part) =>
      part === 'secret' ||
      part === 'secrets' ||
      part.startsWith('secret/') ||
      part.startsWith('secrets/'),
  );
}

/**
 * True when argv contains a `get` command that includes secrets in the resource
 * type. Handles leading global flags (e.g. `--context=...` prepended by
 * runKubectl) and comma-separated resource types (e.g. `secret,configmap`).
 */
export function isGetSecretCommand(argv: string[]): boolean {
  // Scan past any leading global flags to find the 'get' subcommand.
  let getIndex = -1;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'get') {
      getIndex = i;
      break;
    }
    if (!arg.startsWith('-')) return false; // Non-flag before 'get' → not a get command.
    if (!arg.includes('=') && FLAGS_CONSUMING_NEXT.has(arg)) i++; // skip flag value token
  }
  if (getIndex === -1) return false;

  let i = getIndex + 1;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith('-')) {
      if (!a.includes('=') && FLAGS_CONSUMING_NEXT.has(a)) i++;
      i++;
      continue;
    }
    return isSecretResource(a);
  }
  return false;
}

/**
 * Return true when the parsed JSON value is a Kubernetes Secret or a List/SecretList
 * containing at least one Secret. Returns false for arrays, primitives, and all other
 * resource types.
 */
export function containsSecret(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const o = obj as Record<string, unknown>;
  if (o['kind'] === 'Secret') return true;
  if ((o['kind'] === 'List' || o['kind'] === 'SecretList') && Array.isArray(o['items'])) {
    return (o['items'] as unknown[]).some(containsSecret);
  }
  return false;
}

/**
 * Replace every field value with a `<redacted: N bytes>` placeholder.
 * When `isBase64` is true, the byte count is estimated from the base64-encoded
 * string length (floor((len - padding) * 3/4)). Otherwise UTF-8 byte length is
 * used directly. Non-string values are coerced to string before measurement.
 */
export function redactDataFields(
  fields: Record<string, unknown>,
  isBase64: boolean,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    const str = typeof value === 'string' ? value : String(value ?? '');
    const byteCount = isBase64
      ? Math.floor(str.replace(/=+$/, '').length * 3 / 4)
      : Buffer.byteLength(str, 'utf8');
    result[key] = `<redacted: ${byteCount} bytes>`;
  }
  return result;
}

function redactSecret(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...obj };
  if (result['data'] && typeof result['data'] === 'object' && !Array.isArray(result['data'])) {
    result['data'] = redactDataFields(result['data'] as Record<string, unknown>, true);
  }
  if (result['stringData'] && typeof result['stringData'] === 'object' && !Array.isArray(result['stringData'])) {
    result['stringData'] = redactDataFields(result['stringData'] as Record<string, unknown>, false);
  }
  return result;
}

export function redactObject(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const o = obj as Record<string, unknown>;
  if (o['kind'] === 'Secret') return redactSecret(o);
  if ((o['kind'] === 'List' || o['kind'] === 'SecretList') && Array.isArray(o['items'])) {
    return { ...o, items: (o['items'] as unknown[]).map(redactObject) };
  }
  return obj;
}

/**
 * Redact Kubernetes Secret `.data` and `.stringData` values from kubectl output.
 *
 * - JSON output: parsed, Secrets redacted, re-serialised as JSON.
 * - YAML output: parsed (multi-doc aware), Secrets redacted, re-serialised.
 * - Non-JSON/YAML on a `get secret` command: returns REDACTED_FORMAT_MESSAGE
 *   because values cannot be reliably parsed from jsonpath/go-template output.
 * - All other commands or non-Secret output: returned unchanged.
 */
export function redactSecretValues(output: string, argv: string[]): string {
  if (!output) return output;

  const format = detectFormat(argv);

  if (format === 'json') {
    try {
      const parsed: unknown = JSON.parse(output);
      if (!containsSecret(parsed)) return output;
      const redacted = redactObject(parsed);
      return JSON.stringify(redacted, null, 2);
    } catch {
      return output;
    }
  }

  if (format === 'yaml') {
    try {
      const docs = yaml.loadAll(output) as unknown[];
      if (!docs.some(containsSecret)) return output;
      const redacted = docs.map(redactObject);
      if (redacted.length === 1) {
        return yaml.dump(redacted[0], { lineWidth: -1, noRefs: true });
      }
      return redacted.map((d) => yaml.dump(d, { lineWidth: -1, noRefs: true })).join('---\n');
    } catch {
      return output;
    }
  }

  // Non-JSON/YAML format on a get-secret command: values cannot be reliably redacted.
  if (isGetSecretCommand(argv)) {
    return REDACTED_FORMAT_MESSAGE;
  }

  return output;
}
