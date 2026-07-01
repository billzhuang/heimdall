/** Escape a string for use as a literal inside a RegExp constructor. */
export function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
