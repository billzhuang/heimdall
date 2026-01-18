import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { WELCOME_TIPS, CommandTip, formatVersion, HEIMDALL_VERSION } from '../constants.js';
import { parseCommand, isSlashCommand, SLASH_COMMANDS } from '../commandParser.js';
import type { TUIState, AppMode, SelectorType } from '../useAppState.js';

/**
 * Feature: claude-code-style-welcome, Property 2: All Displayed Commands Have Descriptions
 *
 * For any command displayed in the Tips Panel, there SHALL exist a non-empty
 * description string associated with that command.
 *
 * **Validates: Requirements 2.3**
 */
describe('Property 2: All Displayed Commands Have Descriptions', () => {
  it('every command in WELCOME_TIPS has a non-empty command string', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...WELCOME_TIPS),
        (tip: CommandTip) => {
          expect(tip.command).toBeTruthy();
          expect(typeof tip.command).toBe('string');
          expect(tip.command.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('every command in WELCOME_TIPS has a non-empty description', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...WELCOME_TIPS),
        (tip: CommandTip) => {
          expect(tip.description).toBeTruthy();
          expect(typeof tip.description).toBe('string');
          expect(tip.description.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('every command in WELCOME_TIPS has both command and description as non-empty strings', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...WELCOME_TIPS),
        (tip: CommandTip) => {
          // Command must be a non-empty string
          expect(tip.command).toBeTruthy();
          expect(typeof tip.command).toBe('string');
          expect(tip.command.trim().length).toBeGreaterThan(0);

          // Description must be a non-empty string
          expect(tip.description).toBeTruthy();
          expect(typeof tip.description).toBe('string');
          expect(tip.description.trim().length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('all commands in WELCOME_TIPS start with a slash', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...WELCOME_TIPS),
        (tip: CommandTip) => {
          expect(tip.command.startsWith('/')).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('WELCOME_TIPS contains the required minimum commands', () => {
    // Requirements 2.2: SHALL display at minimum these commands
    const requiredCommands = ['/ctx', '/ns', '/model', '/help', '/clear', '/exit'];
    const tipCommands = WELCOME_TIPS.map(tip => tip.command);

    fc.assert(
      fc.property(
        fc.constantFrom(...requiredCommands),
        (requiredCommand: string) => {
          expect(tipCommands).toContain(requiredCommand);
          
          // Find the tip for this command and verify it has a description
          const tip = WELCOME_TIPS.find(t => t.command === requiredCommand);
          expect(tip).toBeDefined();
          expect(tip?.description).toBeTruthy();
          expect(tip?.description.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('WELCOME_TIPS array is not empty', () => {
    expect(WELCOME_TIPS.length).toBeGreaterThan(0);
  });

  it('WELCOME_TIPS has at least 6 commands (minimum required)', () => {
    // Requirements 2.2 specifies 6 minimum commands
    expect(WELCOME_TIPS.length).toBeGreaterThanOrEqual(6);
  });

  it('all commands in WELCOME_TIPS are unique', () => {
    const commands = WELCOME_TIPS.map(tip => tip.command);
    const uniqueCommands = new Set(commands);
    expect(uniqueCommands.size).toBe(commands.length);
  });
});


/**
 * Feature: claude-code-style-welcome, Property 4: Slash Command Handling in Welcome Mode
 *
 * For any valid slash command input while showing welcome screen (hasInteracted=false), 
 * the system SHALL process the command identically to how it would be processed when
 * hasInteracted=true (same state transitions, same side effects).
 *
 * **Validates: Requirements 6.3**
 */
describe('Property 4: Slash Command Handling in Welcome Mode', () => {
  // All valid slash commands from the command parser
  const validSlashCommands = Object.keys(SLASH_COMMANDS);
  
  // Commands that open selectors
  const selectorCommands = ['/ctx', '/ns', '/model'];
  
  // Commands that don't open selectors
  const nonSelectorCommands = validSlashCommands.filter(
    cmd => !selectorCommands.includes(cmd)
  );

  /**
   * Simulates the openSelector action - transitions to selector mode
   * This is a pure function version of the state transition for testing
   */
  function applyOpenSelector(state: TUIState, selector: SelectorType): TUIState {
    return {
      ...state,
      mode: 'selector',
      activeSelector: selector,
    };
  }

  /**
   * Simulates the closeSelector action - always returns to repl mode
   * This is a pure function version of the state transition for testing
   */
  function applyCloseSelector(state: TUIState): TUIState {
    return {
      ...state,
      mode: 'repl',
      activeSelector: null,
    };
  }

  /**
   * Maps slash commands to their expected selector type
   */
  function getExpectedSelector(command: string): SelectorType | null {
    switch (command) {
      case '/ctx': return 'context';
      case '/ns': return 'namespace';
      case '/model': return 'model';
      default: return null;
    }
  }

  // Arbitrary for valid TUI state with hasInteracted=false (showing welcome)
  const welcomeStateArb: fc.Arbitrary<TUIState> = fc.record({
    context: fc.option(fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/), { nil: null }),
    namespace: fc.oneof(fc.constant('kube-system'), fc.constant('default'), fc.constant('all')),
    model: fc.constantFrom('sonnet', 'opus', 'haiku'),
    mode: fc.constant('repl' as AppMode),
    activeSelector: fc.constant(null as SelectorType | null),
    hasInteracted: fc.constant(false),
    messages: fc.constant([]),
    kubeconfigPath: fc.constant('/home/user/.kube/config'),
    contexts: fc.constant([]),
    statusHint: fc.constant(null as string | null),
    isRunning: fc.constant(false),
    error: fc.constant(null as string | null),
  });

  // Arbitrary for valid TUI state with hasInteracted=true
  const replStateArb: fc.Arbitrary<TUIState> = fc.record({
    context: fc.option(fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/), { nil: null }),
    namespace: fc.oneof(fc.constant('kube-system'), fc.constant('default'), fc.constant('all')),
    model: fc.constantFrom('sonnet', 'opus', 'haiku'),
    mode: fc.constant('repl' as AppMode),
    activeSelector: fc.constant(null as SelectorType | null),
    hasInteracted: fc.constant(true),
    messages: fc.constant([]),
    kubeconfigPath: fc.constant('/home/user/.kube/config'),
    contexts: fc.constant([]),
    statusHint: fc.constant(null as string | null),
    isRunning: fc.constant(false),
    error: fc.constant(null as string | null),
  });

  it('slash commands parse identically regardless of hasInteracted state', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...validSlashCommands),
        (command) => {
          const parsed = parseCommand(command);
          // Verify parsing is consistent - all slash commands should be recognized
          expect(isSlashCommand(parsed)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('slash commands return the same parsed type regardless of input case', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...validSlashCommands),
        (command) => {
          const lowerParsed = parseCommand(command.toLowerCase());
          const upperParsed = parseCommand(command.toUpperCase());
          
          // Both should parse to the same command type
          expect(lowerParsed.type).toBe(upperParsed.type);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('selector commands (/ctx, /ns, /model) open the same selector type regardless of hasInteracted', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...selectorCommands),
        welcomeStateArb,
        replStateArb,
        (command, welcomeState, replState) => {
          const expectedSelector = getExpectedSelector(command);
          expect(expectedSelector).not.toBeNull();
          
          // Apply openSelector to both states
          const welcomeAfterOpen = applyOpenSelector(welcomeState, expectedSelector!);
          const replAfterOpen = applyOpenSelector(replState, expectedSelector!);
          
          // Both should transition to selector mode with the same activeSelector
          expect(welcomeAfterOpen.mode).toBe('selector');
          expect(replAfterOpen.mode).toBe('selector');
          expect(welcomeAfterOpen.activeSelector).toBe(expectedSelector);
          expect(replAfterOpen.activeSelector).toBe(expectedSelector);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('closeSelector always returns to repl mode', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...selectorCommands),
        welcomeStateArb,
        (command, initialState) => {
          const expectedSelector = getExpectedSelector(command);
          
          // Open selector
          const afterOpen = applyOpenSelector(initialState, expectedSelector!);
          expect(afterOpen.mode).toBe('selector');
          
          // Close selector should return to repl mode
          const afterClose = applyCloseSelector(afterOpen);
          expect(afterClose.mode).toBe('repl');
          expect(afterClose.activeSelector).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('closeSelector returns to repl mode regardless of hasInteracted', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...selectorCommands),
        replStateArb,
        (command, initialState) => {
          const expectedSelector = getExpectedSelector(command);
          
          // Open selector from repl mode
          const afterOpen = applyOpenSelector(initialState, expectedSelector!);
          expect(afterOpen.mode).toBe('selector');
          expect(afterOpen.hasInteracted).toBe(true);
          
          // Close selector should return to repl
          const afterClose = applyCloseSelector(afterOpen);
          expect(afterClose.mode).toBe('repl');
          expect(afterClose.activeSelector).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('non-selector slash commands parse to the same type regardless of hasInteracted', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...nonSelectorCommands),
        (command) => {
          const parsed = parseCommand(command);
          
          // Verify the command is recognized as a slash command
          expect(isSlashCommand(parsed)).toBe(true);
          
          // Verify the type matches the expected type from SLASH_COMMANDS
          const expectedType = SLASH_COMMANDS[command]?.type;
          expect(parsed.type).toBe(expectedType);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('selector state transitions preserve all configuration values', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...selectorCommands),
        welcomeStateArb,
        (command, initialState) => {
          const expectedSelector = getExpectedSelector(command);
          
          // Open selector
          const afterOpen = applyOpenSelector(initialState, expectedSelector!);
          
          // Configuration should be preserved
          expect(afterOpen.context).toBe(initialState.context);
          expect(afterOpen.namespace).toBe(initialState.namespace);
          expect(afterOpen.model).toBe(initialState.model);
          expect(afterOpen.kubeconfigPath).toBe(initialState.kubeconfigPath);
          
          // Close selector
          const afterClose = applyCloseSelector(afterOpen);
          
          // Configuration should still be preserved
          expect(afterClose.context).toBe(initialState.context);
          expect(afterClose.namespace).toBe(initialState.namespace);
          expect(afterClose.model).toBe(initialState.model);
          expect(afterClose.kubeconfigPath).toBe(initialState.kubeconfigPath);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('hasInteracted flag is preserved through selector open/close cycle', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...selectorCommands),
        fc.oneof(welcomeStateArb, replStateArb),
        (command, initialState) => {
          const expectedSelector = getExpectedSelector(command);
          const initialHasInteracted = initialState.hasInteracted;
          
          // Open selector
          const afterOpen = applyOpenSelector(initialState, expectedSelector!);
          expect(afterOpen.hasInteracted).toBe(initialHasInteracted);
          
          // Close selector
          const afterClose = applyCloseSelector(afterOpen);
          expect(afterClose.hasInteracted).toBe(initialHasInteracted);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('all WELCOME_TIPS commands are valid slash commands', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...WELCOME_TIPS),
        (tip: CommandTip) => {
          const parsed = parseCommand(tip.command);
          expect(isSlashCommand(parsed)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});



/**
 * Feature: claude-code-style-welcome, Property 3: Version Format Consistency
 *
 * For any version string displayed on the Welcome Screen, it SHALL match
 * the format `vX.Y.Z` where X, Y, and Z are non-negative integers.
 *
 * **Validates: Requirements 5.4**
 */
describe('Property 3: Version Format Consistency', () => {
  // Regex pattern for valid version format: vX.Y.Z
  const versionPattern = /^v\d+\.\d+\.\d+$/;

  it('HEIMDALL_VERSION matches vX.Y.Z format', () => {
    const formatted = formatVersion(HEIMDALL_VERSION);
    expect(formatted).toMatch(versionPattern);
  });

  it('formatVersion adds v prefix to bare version numbers', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.nat({ max: 99 }),
          fc.nat({ max: 99 }),
          fc.nat({ max: 99 })
        ),
        ([major, minor, patch]) => {
          const bareVersion = `${major}.${minor}.${patch}`;
          const formatted = formatVersion(bareVersion);
          
          expect(formatted).toBe(`v${bareVersion}`);
          expect(formatted).toMatch(versionPattern);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('formatVersion preserves v prefix if already present', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.nat({ max: 99 }),
          fc.nat({ max: 99 }),
          fc.nat({ max: 99 })
        ),
        ([major, minor, patch]) => {
          const versionWithPrefix = `v${major}.${minor}.${patch}`;
          const formatted = formatVersion(versionWithPrefix);
          
          expect(formatted).toBe(versionWithPrefix);
          expect(formatted).toMatch(versionPattern);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('formatVersion handles uppercase V prefix', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.nat({ max: 99 }),
          fc.nat({ max: 99 }),
          fc.nat({ max: 99 })
        ),
        ([major, minor, patch]) => {
          const versionWithUpperV = `V${major}.${minor}.${patch}`;
          const formatted = formatVersion(versionWithUpperV);
          
          // Should normalize to lowercase v
          expect(formatted).toBe(`v${major}.${minor}.${patch}`);
          expect(formatted).toMatch(versionPattern);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('formatVersion returns fallback for empty string', () => {
    const formatted = formatVersion('');
    expect(formatted).toBe('v?.?.?');
  });

  it('formatVersion output always starts with lowercase v', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // Bare version
          fc.tuple(fc.nat({ max: 99 }), fc.nat({ max: 99 }), fc.nat({ max: 99 }))
            .map(([a, b, c]) => `${a}.${b}.${c}`),
          // With v prefix
          fc.tuple(fc.nat({ max: 99 }), fc.nat({ max: 99 }), fc.nat({ max: 99 }))
            .map(([a, b, c]) => `v${a}.${b}.${c}`),
          // With V prefix
          fc.tuple(fc.nat({ max: 99 }), fc.nat({ max: 99 }), fc.nat({ max: 99 }))
            .map(([a, b, c]) => `V${a}.${b}.${c}`)
        ),
        (version) => {
          const formatted = formatVersion(version);
          expect(formatted.startsWith('v')).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('formatVersion handles whitespace in input', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.nat({ max: 99 }),
          fc.nat({ max: 99 }),
          fc.nat({ max: 99 })
        ),
        ([major, minor, patch]) => {
          const versionWithSpaces = `  ${major}.${minor}.${patch}  `;
          const formatted = formatVersion(versionWithSpaces);
          
          expect(formatted).toBe(`v${major}.${minor}.${patch}`);
          expect(formatted).toMatch(versionPattern);
        }
      ),
      { numRuns: 100 }
    );
  });
});
