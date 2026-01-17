import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseCommand, getSlashCommands } from '../commandParser.js';
import { MODEL_MAP } from '../../constants.js';

/**
 * Property-based tests for command parser
 * These tests validate universal properties across generated inputs
 */
describe('commandParser property tests', () => {
  /**
   * Property 1: Slash Command Parsing
   * For any input string starting with "/" followed by a valid command name,
   * parseCommand SHALL return a command object with the correct type.
   * 
   * **Validates: Requirements 3.1, 4.1, 5.1, 8.3, 8.4**
   */
  describe('Property 1: Slash command parsing', () => {
    const validSlashCommands = ['/ctx', '/ns', '/model', '/help', '/exit', '/clear', '/new', '/compact'];
    const expectedTypes: Record<string, string> = {
      '/ctx': 'ctx',
      '/ns': 'ns',
      '/model': 'model',
      '/help': 'help',
      '/exit': 'exit',
      '/clear': 'clear',
      '/new': 'new',
      '/compact': 'compact',
    };

    it('should return correct type for any valid slash command with optional trailing text', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...validSlashCommands),
          fc.string(),
          (cmd, trailing) => {
            const input = trailing ? `${cmd} ${trailing}` : cmd;
            const result = parseCommand(input);
            expect(result.type).toBe(expectedTypes[cmd]);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should handle case variations of slash commands', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...validSlashCommands),
          (cmd) => {
            // Test uppercase
            const upperResult = parseCommand(cmd.toUpperCase());
            expect(upperResult.type).toBe(expectedTypes[cmd]);
            
            // Test mixed case
            const mixedCase = cmd.charAt(0) + cmd.slice(1).toUpperCase();
            const mixedResult = parseCommand(mixedCase);
            expect(mixedResult.type).toBe(expectedTypes[cmd]);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 2: Quick Check Command Parsing
   * For any input containing quick check keywords, parseCommand SHALL return
   * a quickCheck command with correct mode and model extraction.
   * 
   * **Validates: Requirements 6.3**
   */
  describe('Property 2: Quick check command parsing', () => {
    const checkKeywords = ['check', 'run', 'test', 'scan', 'analyze', 'health'];
    const comprehensiveKeywords = ['all', 'comprehensive', 'full', 'complete', 'thorough', 'deep'];
    const smokeKeywords = ['smoke', 'quick', 'fast', 'rapid', 'brief'];
    const modelNames = Object.keys(MODEL_MAP);

    it('should detect comprehensive mode when comprehensive keywords present', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...checkKeywords),
          fc.constantFrom(...comprehensiveKeywords),
          (checkKw, compKw) => {
            const input = `${compKw} ${checkKw}`;
            const result = parseCommand(input);
            expect(result.type).toBe('quickCheck');
            if (result.type === 'quickCheck') {
              expect(result.mode).toBe('all');
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should detect smoke mode when smoke keywords present', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...checkKeywords),
          fc.constantFrom(...smokeKeywords),
          (checkKw, smokeKw) => {
            const input = `${smokeKw} ${checkKw}`;
            const result = parseCommand(input);
            expect(result.type).toBe('quickCheck');
            if (result.type === 'quickCheck') {
              expect(result.mode).toBe('smoke');
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should extract model when model name present in check command', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...checkKeywords),
          fc.constantFrom(...modelNames),
          (checkKw, model) => {
            const input = `${checkKw} with ${model}`;
            const result = parseCommand(input);
            expect(result.type).toBe('quickCheck');
            if (result.type === 'quickCheck') {
              expect(result.model).toBe(model);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 3: General Query Parsing
   * For any input that is not a slash command, not a quick check, and not a control command,
   * parseCommand SHALL return a query command containing the original text.
   * 
   * **Validates: Requirements 6.1, 6.2, 6.4**
   */
  describe('Property 3: General query parsing', () => {
    // Generate strings that won't match slash commands, control commands, or check keywords
    const nonCommandString = fc.string({ minLength: 1 })
      .filter(s => {
        const trimmed = s.trim().toLowerCase();
        if (!trimmed) return false;
        if (trimmed.startsWith('/')) return false;
        if (['help', '?', 'h', 'exit', 'quit', 'q'].includes(trimmed)) return false;
        if (['check', 'run', 'test', 'scan', 'analyze', 'health'].some(kw => trimmed.includes(kw))) return false;
        return true;
      });

    it('should return query type for non-command input', () => {
      fc.assert(
        fc.property(nonCommandString, (input) => {
          const result = parseCommand(input);
          expect(result.type).toBe('query');
        }),
        { numRuns: 100 }
      );
    });

    it('should preserve original text in query', () => {
      fc.assert(
        fc.property(nonCommandString, (input) => {
          const result = parseCommand(input);
          if (result.type === 'query') {
            expect(result.text).toBe(input.trim());
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 4: Control Command Parsing
   * For any input matching control commands (help, ?, h, exit, quit, q),
   * parseCommand SHALL return the corresponding command type.
   * 
   * **Validates: Requirements 6.6, 6.7**
   */
  describe('Property 4: Control command parsing', () => {
    const helpAliases = ['help', '?', 'h'];
    const exitAliases = ['exit', 'quit', 'q'];

    it('should return help type for all help aliases', () => {
      fc.assert(
        fc.property(fc.constantFrom(...helpAliases), (alias) => {
          const result = parseCommand(alias);
          expect(result.type).toBe('help');
        }),
        { numRuns: 100 }
      );
    });

    it('should return exit type for all exit aliases', () => {
      fc.assert(
        fc.property(fc.constantFrom(...exitAliases), (alias) => {
          const result = parseCommand(alias);
          expect(result.type).toBe('exit');
        }),
        { numRuns: 100 }
      );
    });

    it('should be case insensitive for control commands', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...helpAliases, ...exitAliases),
          (alias) => {
            const upperResult = parseCommand(alias.toUpperCase());
            const lowerResult = parseCommand(alias.toLowerCase());
            expect(upperResult.type).toBe(lowerResult.type);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
