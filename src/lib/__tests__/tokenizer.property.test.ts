import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { tokenizeShellArgs } from '../tokenizer.ts';

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/**
 * A "safe word" contains no whitespace, no quotes, and no backslashes.
 * These are the characters that do NOT trigger any special tokenizer behavior.
 */
const safeWord = fc.stringMatching(/^[A-Za-z0-9._:/@-]+$/).filter((s) => s.length > 0);

/**
 * A "safe inner" string has no single-quote character, so it is safe to embed
 * verbatim inside '...'.  Single quotes have no escaping mechanism, so the only
 * restriction is the absence of `'`.
 */
const safeInner = fc.string({ maxLength: 40 }).filter((s) => !s.includes("'"));

/**
 * A "safe double inner" string has no double-quote or backslash characters.
 * Only `"` and `\` have special meaning inside "...", so any other character
 * is preserved verbatim.
 */
const safeDoubleInner = fc
  .string({ maxLength: 40 })
  .filter((s) => !s.includes('"') && !s.includes('\\'));

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

  it('token count equals word count for safe multi-word inputs', () => {
    fc.assert(
      fc.property(
        fc
          .array(safeWord, { minLength: 1, maxLength: 10 })
          .filter((words) => words[0].toLowerCase() !== 'kubectl'),
        (words) => {
          const tokens = tokenizeShellArgs(words.join(' '), 'kubectl');
          expect(tokens).toHaveLength(words.length);
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
          // First word must not be the binary name; double-stripping would differ.
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

  it('binary name in a non-first position is preserved (not stripped)', () => {
    fc.assert(
      fc.property(
        fc
          .array(safeWord, { minLength: 2, maxLength: 5 })
          .filter(
            (words) =>
              // No word is 'kubectl' (so we can safely insert it at position 1)
              !words.some((w) => w.toLowerCase() === 'kubectl'),
          ),
        (words) => {
          // Insert 'kubectl' at index 1 (not the first position).
          const mixed = [words[0], 'kubectl', ...words.slice(1)].join(' ');
          const tokens = tokenizeShellArgs(mixed, 'kubectl');
          expect(tokens).toContain('kubectl');
        },
      ),
    );
  });

  it('stripping is case-insensitive: KUBECTL, Kubectl, etc. are all stripped', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('kubectl', 'KUBECTL', 'Kubectl', 'KuBeCTL'),
        fc.array(safeWord, { minLength: 1, maxLength: 4 }).filter(
          (words) => words[0].toLowerCase() !== 'kubectl',
        ),
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
    fc.assert(
      fc.property(
        // Generate content that always contains at least one space
        fc.string({ minLength: 1, maxLength: 20 }).filter(
          (s) => s.includes(' ') && !s.includes("'"),
        ),
        (content) => {
          // Wrapping in single quotes prevents splitting on the embedded spaces.
          const tokens = tokenizeShellArgs(`'${content}'`, 'kubectl');
          expect(tokens).toHaveLength(1);
        },
      ),
    );
  });

  it('spaces inside double quotes do not split tokens', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter(
          (s) => s.includes(' ') && !s.includes('"') && !s.includes('\\'),
        ),
        (content) => {
          const tokens = tokenizeShellArgs(`"${content}"`, 'kubectl');
          expect(tokens).toHaveLength(1);
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

  it('extra spaces between words do not affect the token list', () => {
    fc.assert(
      fc.property(
        fc
          .array(safeWord, { minLength: 2, maxLength: 6 })
          .filter((words) => words[0].toLowerCase() !== 'kubectl'),
        fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 5 }),
        (words, spaceCounts) => {
          // Join words with varying numbers of spaces
          let input = words[0];
          for (let i = 1; i < words.length; i++) {
            const n = spaceCounts[(i - 1) % spaceCounts.length];
            input += ' '.repeat(n) + words[i];
          }
          const tokens = tokenizeShellArgs(input, 'kubectl');
          expect(tokens).toEqual(words);
        },
      ),
    );
  });
});
