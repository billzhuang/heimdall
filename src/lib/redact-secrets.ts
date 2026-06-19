/**
 * Pure helpers for redacting Kubernetes Secret values from kubectl output.
 *
 * Design: side-effect-free, testable without cluster access.
 * Handles JSON (`-o json`) and YAML (`-o yaml`) kubectl output.
 * Any other format, or any non-Secret resource, is returned unchanged.
 */
import * as yaml from 'js-yaml';

/**
 * Mutate a parsed Secret object in-place, replacing `.data` and `.stringData`
 * string values with `<redacted: N bytes>` placeholders.
 * Returns true when at least one value was replaced.
 */
function redactSecretObject(obj: Record<string, unknown>): boolean {
  let changed = false;

  // .data values are base64-encoded; report decoded byte count.
  if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
    const map = obj.data as Record<string, unknown>;
    for (const key of Object.keys(map)) {
      const val = map[key];
      if (typeof val === 'string' && val.length > 0) {
        map[key] = `<redacted: ${Buffer.byteLength(val, 'base64')} bytes>`;
        changed = true;
      }
    }
  }

  // .stringData values are plaintext; report UTF-8 byte count.
  if (obj.stringData && typeof obj.stringData === 'object' && !Array.isArray(obj.stringData)) {
    const map = obj.stringData as Record<string, unknown>;
    for (const key of Object.keys(map)) {
      const val = map[key];
      if (typeof val === 'string') {
        map[key] = `<redacted: ${Buffer.byteLength(val, 'utf8')} bytes>`;
        changed = true;
      }
    }
  }

  return changed;
}

/**
 * Walk a parsed kubectl response and redact any Secret resources found.
 * Handles `kind: Secret`, `kind: SecretList`, and mixed `kind: List`.
 * Returns true when at least one value was redacted.
 */
function redactInObject(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const obj = parsed as Record<string, unknown>;

  if (obj.kind === 'Secret') {
    return redactSecretObject(obj);
  }

  if ((obj.kind === 'SecretList' || obj.kind === 'List') && Array.isArray(obj.items)) {
    let changed = false;
    for (const item of obj.items) {
      if (item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).kind === 'Secret') {
        if (redactSecretObject(item as Record<string, unknown>)) changed = true;
      }
    }
    return changed;
  }

  return false;
}

/**
 * Parse `output` as JSON or YAML and replace all `.data` / `.stringData`
 * values in any Kubernetes Secret resource with `<redacted: N bytes>`.
 *
 * Returns `output` unchanged when:
 * - The format cannot be parsed.
 * - No Secret resources are found in the output.
 * - No string values exist under `.data` / `.stringData` to replace.
 *
 * The returned string is re-serialised (JSON 2-space indent, or YAML dump)
 * only when redaction occurred; otherwise the original string is returned.
 */
export function redactSecretValues(output: string, format: 'json' | 'yaml' = 'json'): string {
  if (format === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      return output;
    }
    if (!redactInObject(parsed)) return output;
    return JSON.stringify(parsed, null, 2);
  }

  // YAML format — may be a multi-document stream (kubectl outputs one doc per
  // named resource separated by ---). yaml.loadAll parses all documents; yaml.load
  // would silently truncate everything after the first ---.
  let docs: unknown[];
  try {
    docs = yaml.loadAll(output);
  } catch {
    return output;
  }
  let changed = false;
  for (const doc of docs) {
    if (doc && typeof doc === 'object') {
      if (redactInObject(doc)) changed = true;
    }
  }
  if (!changed) return output;
  try {
    return docs
      .map((doc) => (doc && typeof doc === 'object' ? yaml.dump(doc as Record<string, unknown>) : yaml.dump(doc)))
      .join('---\n');
  } catch {
    return output;
  }
}
