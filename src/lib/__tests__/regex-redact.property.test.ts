import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { compileRules, applyRedaction, createRedactor } from '../regex-redact.ts';

// ---------------------------------------------------------------------------
// Property: compileRules output count is bounded
// ---------------------------------------------------------------------------

describe('compileRules (property-based)', () => {
  it('never produces more compiled rules than input rules', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            name: fc.string({ minLength: 1, maxLength: 20 }),
            pattern: fc.string({ minLength: 1, maxLength: 30 }),
          }),
          { maxLength: 10 },
        ),
        (rules) => {
          const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
          const compiled = compileRules(rules);
          warnSpy.mockRestore();
          expect(compiled.length).toBeLessThanOrEqual(rules.length);
        },
      ),
    );
  });

  it('every compiled rule carries the global flag', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            name: fc.string({ minLength: 1, maxLength: 10 }),
            // Only use safe literal patterns so they compile cleanly
            pattern: fc.constantFrom('SECRET', 'TOKEN', 'KEY', 'PASS', 'API_[A-Z]+'),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (rules) => {
          const compiled = compileRules(rules);
          for (const r of compiled) {
            expect(r.re.flags).toContain('g');
          }
        },
      ),
    );
  });

  it('compiled rule names match source rule names', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            name: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-z_]+$/.test(s)),
            pattern: fc.constantFrom('TOKEN', 'SECRET', 'KEY', 'PASS'),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (rules) => {
          const sourceNames = new Set(rules.map((r) => r.name));
          const compiled = compileRules(rules);
          for (const r of compiled) {
            expect(sourceNames.has(r.name)).toBe(true);
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property: applyRedaction output invariants
// ---------------------------------------------------------------------------

describe('applyRedaction (property-based)', () => {
  it('never changes text when no rules are provided', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(applyRedaction(text, [])).toBe(text);
      }),
    );
  });

  it('replacement tokens always have the form [REDACTED:<name>]', () => {
    // Apply a rule that matches a fixed literal so we know exactly what's replaced
    const rules = compileRules([{ name: 'tok', pattern: 'SECRET' }]);
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer({ min: 1, max: 6 }),
          fc.array(
            fc
              .string({ maxLength: 20 })
              .filter((s) => !s.includes('SECRET') && !s.includes('[REDACTED:')),
            { minLength: 0, maxLength: 5 },
          ),
        ),
        ([count, fillers]) => {
          // Build a string interleaving fillers and "SECRET" tokens
          const parts: string[] = [];
          for (let i = 0; i < count; i++) {
            if (fillers[i]) parts.push(fillers[i]);
            parts.push('SECRET');
          }
          const input = parts.join(' ');
          const result = applyRedaction(input, rules);
          expect(result).not.toContain('SECRET');
          // Count of replacement tokens must equal the number of SECRET tokens inserted
          const replacements = result.match(/\[REDACTED:tok\]/g) ?? [];
          expect(replacements).toHaveLength(count);
        },
      ),
    );
  });

  it('is idempotent: applying the same rules twice yields the same result as once', () => {
    // Use a simple literal rule
    const rules = compileRules([{ name: 'key', pattern: 'APIKEY' }]);
    fc.assert(
      fc.property(fc.string(), (text) => {
        const once = applyRedaction(text, rules);
        const twice = applyRedaction(once, rules);
        expect(twice).toBe(once);
      }),
    );
  });

  it('text without any pattern match is returned unchanged', () => {
    const rules = compileRules([{ name: 'aws', pattern: 'AKIA[0-9A-Z]{16}' }]);
    fc.assert(
      fc.property(
        // Generate strings that cannot contain "AKIA"
        fc.string().filter((s) => !s.includes('AKIA')),
        (text) => {
          expect(applyRedaction(text, rules)).toBe(text);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property: createRedactor behaves identically to compileRules + applyRedaction
// ---------------------------------------------------------------------------

describe('createRedactor (property-based)', () => {
  it('produces the same output as compileRules + applyRedaction', () => {
    const rawRules = [
      { name: 'secret', pattern: 'SECRET' },
      { name: 'token', pattern: 'TOKEN[0-9]+' },
    ];
    const redact = createRedactor(rawRules);
    const compiled = compileRules(rawRules);

    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(redact(text)).toBe(applyRedaction(text, compiled));
      }),
    );
  });

  it('calling the returned function multiple times with different strings is safe', () => {
    const redact = createRedactor([{ name: 'tok', pattern: 'TOKEN[0-9]+' }]);
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        // Should not throw or corrupt state from a previous call
        const ra = redact(a);
        const rb = redact(b);
        // Re-running must be stable
        expect(redact(a)).toBe(ra);
        expect(redact(b)).toBe(rb);
      }),
    );
  });
});
