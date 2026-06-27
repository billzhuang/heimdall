import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { tokenize, tokenizeShellArgs } from '../tokenizer.ts';

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/**
 * A "safe word" contains no whitespace, no quotes, and no backslashes.
 * Hyphen is placed at the start of the class to avoid range interpretation.
 */
const safeWord = fc.stringMatching(/^[-A-Za-z0-9._:/@]+$/).filter((s) => s.length > 0);

/**
 * A "safe inner" string has no single-quote — safe to embed verbatim in '...'.
 * Single quotes have no escaping mechanism, so the only restriction is the
 * absence of `'`.
 */
const safeInner = fc.string({ maxLength: 40 }).filter((s) => !s.includes("'"));

/**
 * A "safe double inner" string has no `"` or `\` — safe to embed in "...".
 * Only those two characters have special meaning inside double quotes.
 */
const safeDoubleInner = fc
  .string({ maxLength: 40 })
  .filter((s) => !s.includes('"') && !s.includes('\\'));

/**
 * Content with a guaranteed space, no apostrophes.
 * Built from two filtered halves so the filter acceptance rate stays high —
 * avoiding the fast-check "too many skips" exhaustion failure that occurs
 * when filtering a single string for s.includes(' ').
 */
const contentWithSpace = fc
  .tuple(
    fc.string({ maxLength: 10 }).filter((s) => !s.includes("'")),
    fc.string({ maxLength: 10 }).filter((s) => !s.includes("'")),
  )
  .map(([a, b]) => a + ' ' + b);

/**
 * Content with a guaranteed space, no `"` or `\`.
 * Same safe-construction pattern as contentWithSpace.
 */
const doubleContentWithSpace = fc
  .tuple(
    fc.string({ maxLength: 10 }).filter((s) => !s.includes('"') && !s.includes('\\')),
    fc.string({ maxLength: 10 }).filter((s) => !s.includes('"') && !s.includes('\\')),
  )
  .map(([a, b]) => a + ' ' + b);

// ---------------------------------------------------------------------------
// Roundtrip
// ---------------------------------------------------------------------------

describe('tokenizeShellArgs (property-based) — roundtrip', () => {
  it('safe words joined with spaces tokenize back to the original array', () => {
    fc.assert(
      fc.property(
        fc
          .array(safeWord, { minLength: 1, maxLength: 8 })
          // Exclude 'kubectl' as the first word so binary-name stripping does not apply.
          .filter((words) => words[0].toLowerCase() !== 'kubectl'),
        (words) => {
          const tokens = tokenizeShellArgs(words.join(' '), 'kubectl');
          expect(tokens).toEqual(words);
        },
      ),
    );
  });

  it('no output token contains bare whitespace for safe-word inputs', () => {
    fc.assert(
      fc.property(
        fc
          .array(safeWord, { minLength: 1, maxLength: 8 })
          .filter((words) => words[0].toLowerCase() !== 'kubectl'),
        (words) => {
          const tokens = tokenizeShellArgs(words.join(' '), 'kubectl');
          for (const token of tokens) {
            expect(/\s/.test(token)).toBe(false);
          }
        },
      ),
    );
  });

  it('extra spaces between words do not affect the token list', () => {
    fc.assert(
      fc.property(
        fc
          .array(safeWord, { minLength: 2, maxLength: 6 })
          .filter((words) => words[0].toLowerCase() !== 'kubectl'),
        fc.array(fc.integer({ min: 2, max: 4 }), { minLength: 1, maxLength: 5 }),
        (words, spaceCounts) => {
          let input = words[0];
          for (let i = 1; i < words.length; i++) {
            input += ' '.repeat(spaceCounts[(i - 1) % spaceCounts.length]) + words[i];
          }
          expect(tokenizeShellArgs(input, 'kubectl')).toEqual(words);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Binary name stripping
// ---------------------------------------------------------------------------

describe('tokenizeShellArgs (property-based) — binary name stripping', () => {
  it('prepending binaryName gives the same result as not prepending it', () => {
    fc.assert(
      fc.property(
        fc
          .array(safeWord, { minLength: 1, maxLength: 5 })
          // First word must not be the binary name to prevent double-stripping.
          .filter((words) => words[0].toLowerCase() !== 'kubectl'),
        (words) => {
          const rest = words.join(' ');
          expect(tokenizeShellArgs('kubectl ' + rest, 'kubectl')).toEqual(
            tokenizeShellArgs(rest, 'kubectl'),
          );
        },
      ),
    );
  });

  it('binary name at index 1 (not first position) is preserved in the output', () => {
    fc.assert(
      fc.property(
        fc
          .array(safeWord, { minLength: 2, maxLength: 5 })
          .filter((words) => !words.some((w) => w.toLowerCase() === 'kubectl')),
        (words) => {
          // words[0] is not 'kubectl' → stays first; 'kubectl' at index 1 → NOT stripped.
          const mixed = [words[0], 'kubectl', ...words.slice(1)].join(' ');
          const tokens = tokenizeShellArgs(mixed, 'kubectl');
          // The resulting token at index 1 must be 'kubectl' (not stripped).
          expect(tokens[1]).toBe('kubectl');
        },
      ),
    );
  });

  it('stripping is case-insensitive: KUBECTL, Kubectl, KuBeCTL are all stripped', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('kubectl', 'KUBECTL', 'Kubectl', 'KuBeCTL'),
        fc
          .array(safeWord, { minLength: 1, maxLength: 4 })
          .filter((words) => words[0].toLowerCase() !== 'kubectl'),
        (variant, words) => {
          const withVariant = `${variant} ${words.join(' ')}`;
          const without = words.join(' ');
          expect(tokenizeShellArgs(withVariant, 'kubectl')).toEqual(
            tokenizeShellArgs(without, 'kubectl'),
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

describe('tokenizeShellArgs (property-based) — quoting', () => {
  it('single-quoted content (no apostrophes) produces exactly one token with that content', () => {
    fc.assert(
      fc.property(safeInner, (content) => {
        const tokens = tokenizeShellArgs(`'${content}'`, 'kubectl');
        expect(tokens).toHaveLength(1);
        expect(tokens[0]).toBe(content);
      }),
    );
  });

  it('double-quoted content (no quotes or backslashes) produces exactly one token', () => {
    fc.assert(
      fc.property(safeDoubleInner, (content) => {
        const tokens = tokenizeShellArgs(`"${content}"`, 'kubectl');
        expect(tokens).toHaveLength(1);
        expect(tokens[0]).toBe(content);
      }),
    );
  });

  it('spaces inside single quotes do not split tokens', () => {
    // contentWithSpace is built from two halves joined by a space, avoiding high
    // rejection rates from filtering a whole string for .includes(' ').
    fc.assert(
      fc.property(contentWithSpace, (content) => {
        const tokens = tokenizeShellArgs(`'${content}'`, 'kubectl');
        expect(tokens).toHaveLength(1);
      }),
    );
  });

  it('spaces inside double quotes do not split tokens', () => {
    fc.assert(
      fc.property(doubleContentWithSpace, (content) => {
        const tokens = tokenizeShellArgs(`"${content}"`, 'kubectl');
        expect(tokens).toHaveLength(1);
      }),
    );
  });

  it('adjacent quoted and unquoted segments concatenate into a single token', () => {
    // Shell tokenisation: prefix"middle"suffix → one token whose value is prefix+middle+suffix.
    fc.assert(
      fc.property(
        fc
          .tuple(safeWord, safeDoubleInner, safeWord)
          // Exclude the edge case where the concatenated token equals the binary name.
          .filter(([a, b, c]) => (a + b + c).toLowerCase() !== 'kubectl'),
        ([prefix, middle, suffix]) => {
          const input = `${prefix}"${middle}"${suffix}`;
          const tokens = tokenizeShellArgs(input, 'kubectl');
          expect(tokens).toHaveLength(1);
          expect(tokens[0]).toBe(prefix + middle + suffix);
        },
      ),
    );
  });

  it('unterminated single quote produces one token with all remaining characters', () => {
    // The tokenizer does not error on unclosed quotes — it treats all characters
    // up to end-of-input as the token content.  This test documents that contract.
    fc.assert(
      fc.property(
        // Exclude the exact binary name so the single token is not stripped.
        safeInner.filter((s) => s.toLowerCase() !== 'kubectl'),
        (content) => {
          const tokens = tokenizeShellArgs(`'${content}`, 'kubectl');
          expect(tokens).toHaveLength(1);
          expect(tokens[0]).toBe(content);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Whitespace
// ---------------------------------------------------------------------------

describe('tokenizeShellArgs (property-based) — whitespace', () => {
  it('whitespace-only inputs always produce empty arrays', () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom(' ', '\t', '\n'), { minLength: 0, maxLength: 15 })
          .map((chars) => chars.join('')),
        (input) => {
          expect(tokenizeShellArgs(input, 'kubectl')).toEqual([]);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// tokenize — delegates correctly from tokenizeShellArgs
// ---------------------------------------------------------------------------

describe('tokenize (property-based) — consistent with tokenizeShellArgs', () => {
  it('tokenize(input) equals tokenizeShellArgs(input, binaryName) when first token does not match binaryName', () => {
    // Use 'zz-never-matches' as the binary name — safe words never start with 'zz-never-matches'.
    fc.assert(
      fc.property(
        fc.array(safeWord, { minLength: 1, maxLength: 6 }),
        (words) => {
          const input = words.join(' ');
          expect(tokenize(input)).toEqual(tokenizeShellArgs(input, 'zz-never-matches'));
        },
      ),
    );
  });

  it('tokenize(binaryName + " " + rest) equals [binaryName, ...tokenizeShellArgs(rest, binaryName)]', () => {
    // tokenize keeps the binary name; tokenizeShellArgs strips it and returns only the rest.
    fc.assert(
      fc.property(
        fc
          .array(safeWord, { minLength: 1, maxLength: 5 })
          .filter((words) => words[0].toLowerCase() !== 'kubectl'),
        (words) => {
          const rest = words.join(' ');
          const full = 'kubectl ' + rest;
          expect(tokenize(full)).toEqual(['kubectl', ...tokenizeShellArgs(rest, 'kubectl')]);
        },
      ),
    );
  });
});
