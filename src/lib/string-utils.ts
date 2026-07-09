/** Tiny pure string-formatting helpers shared across CLI mode entry points. */

/** Pluralize a noun by count, e.g. `pluralize(1, 'entry', 'entries')` -> 'entry'. */
export function pluralize(count: number, singular: string, plural: string = `${singular}s`): string {
  return count === 1 ? singular : plural;
}
