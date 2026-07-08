/**
 * Tiny pure helpers for validating/extracting fields from `JSON.parse`-ed
 * request bodies (`unknown` values of untrusted shape).
 */

/** Narrows `v` to a non-null, non-array object. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Return `v` if it is a string, else `undefined`. */
export function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Validate that `field` on `parsed` is a non-empty (post-trim) string.
 * Returns the trimmed value on success, or the standard "required" error
 * message shared by every request-body parser that needs this guard.
 */
export function requireNonEmptyStringField(
  parsed: Record<string, unknown>,
  field: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = parsed[field];
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: `"${field}" is required and must be a non-empty string` };
  }
  return { ok: true, value: value.trim() };
}
