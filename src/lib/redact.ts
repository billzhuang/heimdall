/**
 * Redacts Kubernetes Secret .data and .stringData values from kubectl output.
 *
 * Pure (no I/O). Applied in runKubectl after execution, before caching and
 * returning, so secret values never reach the model regardless of prompt
 * instructions.
 */
import * as yaml from 'js-yaml';

export const REDACTED_FORMAT_MESSAGE =
  'Secret values cannot be safely extracted in this output format. ' +
  'Use -o json or -o yaml to inspect Secrets — values will be redacted automatically.';

function detectFormat(argv: string[]): 'json' | 'yaml' | 'other' {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o=json' || a === '--output=json') return 'json';
    if (a === '-o=yaml' || a === '--output=yaml') return 'yaml';
    if ((a === '-o' || a === '--output') && i + 1 < argv.length) {
      const val = argv[i + 1];
      if (val === 'json') return 'json';
      if (val === 'yaml') return 'yaml';
      return 'other';
    }
  }
  return 'other';
}

const FLAGS_CONSUMING_NEXT = new Set([
  '-n', '--namespace', '-o', '--output', '-l', '--selector', '-f', '--filename',
  '-c', '--container', '--context', '--kubeconfig', '--as', '-v', '--v',
  '--server', '-s', '--token', '--user', '--username', '--password', '--cluster',
  '--field-selector', '--sort-by', '-L', '--label-columns',
]);

/** True when argv represents a `get secret[s]` command (not mixed resource types). */
export function isGetSecretCommand(argv: string[]): boolean {
  if (argv.length === 0 || argv[0] !== 'get') return false;
  let i = 1;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith('-')) {
      if (!a.includes('=') && FLAGS_CONSUMING_NEXT.has(a)) i++;
      i++;
      continue;
    }
    const lower = a.toLowerCase();
    return (
      lower === 'secret' ||
      lower === 'secrets' ||
      lower.startsWith('secret/') ||
      lower.startsWith('secrets/')
    );
  }
  return false;
}

/** True when the parsed object is or contains a Kubernetes Secret. */
function containsSecret(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const o = obj as Record<string, unknown>;
  if (o['kind'] === 'Secret') return true;
  if ((o['kind'] === 'List' || o['kind'] === 'SecretList') && Array.isArray(o['items'])) {
    return (o['items'] as unknown[]).some(containsSecret);
  }
  return false;
}

function redactDataFields(
  fields: Record<string, unknown>,
  isBase64: boolean,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    const str = typeof value === 'string' ? value : String(value ?? '');
    const byteCount = isBase64
      ? Math.floor(str.replace(/=+$/, '').length * 3 / 4)
      : str.length;
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

function redactObject(obj: unknown): unknown {
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
