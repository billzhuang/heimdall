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
