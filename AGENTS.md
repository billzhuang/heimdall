# Heimdall - AI Agent Guidelines

> This document helps AI assistants understand and contribute to Heimdall effectively.

## 🎯 Project Overview

Heimdall is an AI-powered Kubernetes assistant and SRE agent. It provides an interactive TUI (Terminal User Interface) built with React/Ink that allows users to query their Kubernetes clusters using natural language.

**Core Value**: Help SREs and developers diagnose K8s issues faster by combining kubectl with AI reasoning.

## 🏗️ Architecture

```
src/
├── index.ts              # CLI entry point (Commander.js)
├── tui/
│   ├── index.tsx         # TUI entry point (Ink render)
│   ├── components/       # React/Ink UI components
│   │   ├── App.tsx       # Main app component, state orchestration
│   │   ├── StatusBar.tsx # Shows context/namespace/model
│   │   ├── InputField.tsx
│   │   ├── OutputArea.tsx
│   │   ├── Selector.tsx  # Generic selector component
│   │   ├── ContextSelector.tsx
│   │   ├── NamespaceSelector.tsx
│   │   └── ModelSelector.tsx
│   ├── useAppState.ts    # Centralized state management hook
│   ├── commandParser.ts  # Parse user input into commands
│   ├── agentRunner.ts    # Claude Agent SDK integration
│   ├── kubeconfigParser.ts # Parse ~/.kube/config
│   ├── constants.ts      # Model definitions
│   ├── types.ts          # Shared types
│   └── __tests__/        # Unit & property-based tests
```

## 🔧 Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 18+ (ESM) |
| Language | TypeScript 5.x (strict mode) |
| TUI Framework | Ink 6.x (React for CLI) |
| AI Integration | @anthropic-ai/claude-agent-sdk |
| CLI Framework | Commander.js |
| Testing | Vitest + fast-check (property-based) |
| Build | tsc (no bundler) |

## 📋 Development Commands

```bash
npm run dev          # Run in development (tsx)
npm run build        # Compile TypeScript
npm run typecheck    # Type check without emit
npm test             # Run all tests
npm run test:watch   # Watch mode
npm run test:coverage # Coverage report
```

## ⚠️ Critical Rules

### 1. Always Clean Build After Changes
```bash
rm -rf dist && npm run build
```
TypeScript incremental builds can leave stale `.js` files that cause runtime errors.

### 2. Test Coverage Requirements
- **Business logic** (commandParser, kubeconfigParser, agentRunner): Must have unit tests
- **State management** (useAppState): Must have unit tests for state transitions
- **Property-based tests**: Use fast-check for parsing/validation logic
- Run `npm run test:coverage` to verify coverage

### 3. React/Ink Patterns

**State Management**:
```typescript
// ✅ Good: Functional setState to avoid stale closures
setState(prev => ({ ...prev, newValue }));

// ❌ Bad: Direct state reference in callbacks
setState({ ...state, newValue }); // state may be stale!
```

**useEffect Dependencies**:
```typescript
// ✅ Good: Use ref to run effect only once
const hasInitialized = useRef(false);
useEffect(() => {
  if (hasInitialized.current) return;
  hasInitialized.current = true;
  // initialization logic
}, [deps]);

// ❌ Bad: Object in deps causes infinite re-runs
useEffect(() => { ... }, [actions]); // actions is new object each render!
```

**Atomic State Updates**:
```typescript
// ✅ Good: Single setState with all related changes
const setContext = useCallback((context: string) => {
  setState(prev => ({ 
    ...prev, 
    context,
    namespace: getDefaultNs(context), // Reset related state
    mode: 'repl',
    activeSelector: null,
  }));
}, []);

// ❌ Bad: Multiple setState calls can cause race conditions
setContext(ctx);
setNamespace(ns);
closeSelector();
```

### 4. ESM Module Imports
```typescript
// ✅ Always use .js extension for local imports
import { foo } from './utils.js';

// ❌ Will fail at runtime
import { foo } from './utils';
```

### 5. Agent Safety
The agent runs kubectl commands. System prompt enforces READ-ONLY mode:
- ✅ Allowed: `kubectl get`, `describe`, `logs`, `top`
- ❌ Forbidden: `kubectl apply`, `delete`, `patch`, `create`

## 🧪 Testing Strategy

### Unit Tests
Location: `src/tui/__tests__/*.test.ts`

```typescript
describe('parseCommand', () => {
  it('should parse slash commands', () => {
    expect(parseCommand('/ctx')).toEqual({ type: 'ctx' });
  });
});
```

### Property-Based Tests
Location: `src/tui/__tests__/*.property.test.ts`

```typescript
import * as fc from 'fast-check';

it('should preserve text in query commands', () => {
  fc.assert(
    fc.property(fc.string(), (input) => {
      const result = parseCommand(input);
      if (result.type === 'query') {
        expect(result.text).toBe(input.trim());
      }
    })
  );
});
```

### Component Tests
Location: `src/tui/__tests__/components/*.test.tsx`

```typescript
import { render } from 'ink-testing-library';

it('should render status bar', () => {
  const { lastFrame } = render(<StatusBar context="prod" ... />);
  expect(lastFrame()).toContain('prod');
});
```

## 🔄 Common Workflows

### Adding a New Slash Command

1. **Update commandParser.ts**:
```typescript
export const SLASH_COMMANDS = {
  // ... existing
  '/newcmd': { type: 'newcmd', description: 'Description' },
};
```

2. **Update SlashCommand type**:
```typescript
export type SlashCommand =
  | { type: 'ctx' }
  // ... existing
  | { type: 'newcmd' };
```

3. **Handle in App.tsx**:
```typescript
case 'newcmd':
  // implementation
  break;
```

4. **Add tests** in `commandParser.test.ts`

### Adding a New UI Component

1. Create component in `src/tui/components/`
2. Export from component file
3. Import in App.tsx
4. Add tests in `src/tui/__tests__/components/`

### Modifying State

1. Update `TUIState` interface in `useAppState.ts`
2. Update `createInitialState()` if needed
3. Add action to `AppStateActions` interface
4. Implement action with `useCallback`
5. Add to `actions` object in `useMemo`
6. Update tests in `stateManagement.test.ts`

## 🐛 Debugging Tips

### WASM/Yoga Layout Errors
```
RuntimeError: memory access out of bounds
at wasm://wasm/...yoga-wasm...
```
Usually caused by rendering invalid state. Check:
- Component receiving undefined/null props
- Async state updates racing with unmount

### State Not Updating
1. Check useEffect dependencies
2. Verify not using stale closure
3. Ensure single atomic setState call
4. Clean build: `rm -rf dist && npm run build`

### Agent Not Responding
1. Check `ANTHROPIC_API_KEY` is set
2. Verify model ID in constants.ts
3. Check network connectivity

## 📁 Key Files Reference

| File | Purpose |
|------|---------|
| `useAppState.ts` | All app state, single source of truth |
| `commandParser.ts` | User input → structured commands |
| `agentRunner.ts` | Claude SDK integration, system prompt |
| `kubeconfigParser.ts` | Parse kubeconfig, fetch namespaces |
| `App.tsx` | Main component, orchestrates everything |
| `constants.ts` | Model IDs and labels |

## 🎨 Code Style

- **Formatting**: Prettier defaults (no config file)
- **Linting**: TypeScript strict mode is the linter
- **Naming**: camelCase for functions/variables, PascalCase for components/types
- **Comments**: JSDoc for public APIs, inline for complex logic
- **Imports**: Group by external → internal → types

## 💡 Pro Tips

1. **Read existing tests first** - They document expected behavior
2. **Property tests catch edge cases** - Use fast-check for parsing logic
3. **Ink is React** - Same patterns apply (hooks, components, props)
4. **State flows down** - App.tsx owns state, passes to children
5. **Commands flow up** - Children call action callbacks
6. **Agent is stateless** - Each query is independent (context managed separately)

## 🚫 Anti-Patterns to Avoid

- ❌ Modifying state directly
- ❌ Multiple setState calls for related changes
- ❌ Objects/arrays in useEffect deps without useMemo
- ❌ Forgetting .js extension in imports
- ❌ Running dev server with stale dist/
- ❌ Skipping tests for "simple" changes
- ❌ Hardcoding kubectl commands without --context flag
