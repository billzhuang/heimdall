/**
 * Factory for output-truncation functions used across all CLI/HTTP tool runners.
 *
 * Each runner has a different character limit and a different hint telling the
 * user how to narrow their query. Call `makeTruncate` once at module level to
 * get a bound truncate function with the right limit and hint baked in.
 */
export function makeTruncate(maxChars: number, hint: string): (text: string) => string {
  return function truncate(text: string): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + `\n\n[output truncated at ${maxChars} characters — ${hint}]`;
  };
}
