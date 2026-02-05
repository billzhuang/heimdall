# Heimdall - AI Agent Guidelines

> This document helps AI assistants understand and contribute to Heimdall effectively.

## 🎯 Project Overview

Heimdall is an AI-powered Cloud SRE agent specializing in Kubernetes and AWS operations. It provides an interactive TUI (Terminal User Interface) built with React/Ink that allows users to query their infrastructure using natural language.

**Core Value**: Help SREs and developers diagnose K8s and AWS issues faster by combining kubectl, AWS CLI, and AI reasoning with specialized sub-agents.

## 🚀 Quick Start

**Requirements:** Node.js 20+, `kubectl` access to cluster, AWS CLI (optional), `ANTHROPIC_API_KEY` env var.

```bash
npm install              # Install deps
npm run dev              # Run interactive TUI
npm run dev -- --verbose # With verbose output
npm run dev -- --kubeconfig /path/to/config  # Custom kubeconfig
npm run build            # Build
npm start                # Run built CLI
```

## 🎮 TUI Usage

- Slash commands: `/ctx`, `/ns`, `/model`, `/resume`, `/continue`, `/new`, `/clear`, `/help`, `/exit`
- Ctrl+C: Clear input (if text), quit (if empty)
- ESC: Cancel running queries
- Sessions auto-save and can be resumed

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
│   │   ├── ModelSelector.tsx
│   │   └── SessionSelector.tsx
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
The agent runs kubectl and AWS CLI commands. System prompt enforces READ-ONLY mode:
- ✅ Allowed: `kubectl get`, `describe`, `logs`, `top`
- ✅ Allowed: `aws describe-*`, `list-*`, `get-*` (read-only operations)
- ❌ Forbidden: `kubectl apply`, `delete`, `patch`, `create`
- ❌ Forbidden: `aws create-*`, `delete-*`, `terminate-*`, `update-*` (write operations)

Safety hooks (`safetyHooks.ts`) programmatically block destructive commands at the SDK level.

### 6. Response Format
All agent responses must include:
- `Thinking Summary` (2-5 bullets, high-level reasoning)
- `Answer` (full response)
Never reveal hidden chain-of-thought or internal scratch work.

## 🤖 Sub-Agent Architecture

Heimdall uses the Claude Agent SDK's built-in sub-agent delegation system. The main agent orchestrates and delegates specialized tasks to focused sub-agents.

### Kubernetes Sub-Agents
- **log-analyzer**: Deep log analysis, error correlation, pattern detection
- **resource-analyzer**: CPU/memory analysis, capacity planning, resource optimization
- **network-debugger**: DNS, services, ingress, connectivity troubleshooting
- **security-auditor**: RBAC, secrets, security contexts, policy review
- **web-researcher**: CVE lookup, documentation search, best practices

### AWS Sub-Agents
- **eks-troubleshooter**: EKS cluster issues, node groups, AWS-specific K8s problems
- **aws-cli-analyzer**: AWS account checks, service configurations, resource inventory
- **iam-auditor**: IAM policies, roles, permissions, trust relationships
- **cost-analyzer**: Cost analysis, resource optimization, billing insights
- **service-health-checker**: AWS service health, quotas, limits, region status

### Sub-Agent Implementation
All sub-agents are defined in `agentRunner.ts` via the `buildAgentDefinitions()` function:

```typescript
interface AgentDefinition {
  description: string;  // When/how to invoke this agent
  prompt: string;       // Specialized system prompt
  tools?: string[];     // Allowed tools only
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  maxTurns?: number;    // Prevent infinite loops
}
```

**Key Principles:**
1. **Single Responsibility**: Each sub-agent has one narrowly defined role
2. **Least Privilege**: Only grant tools absolutely needed
3. **Context Isolation**: Sub-agents maintain isolated context windows
4. **Automatic Delegation**: Main agent uses Task tool based on descriptions
5. **Safety Enforcement**: All safety hooks apply to all agents (parent + children)

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

### Safety Hook Tests
Location: `src/tui/__tests__/safetyHooks.test.ts`

```typescript
it('rewrites kubectl get -o json to use cache', async () => {
  // see tests for details
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

### Kubectl Cache Behavior
If API calls repeat too frequently, check cache env vars:
- `HEIMDALL_KUBECTL_CACHE=0` disables cache
- `HEIMDALL_KUBECTL_CACHE_TTL=30` sets TTL (seconds)
- `HEIMDALL_KUBECTL_CACHE_DIR=/tmp` overrides cache directory

## 📁 Key Files Reference

| File | Purpose |
|------|---------|
| `useAppState.ts` | All app state, single source of truth |
| `commandParser.ts` | User input → structured commands |
| `agentRunner.ts` | Claude SDK integration, system prompt |
| `safetyHooks.ts` | Command safety + kubectl JSON cache wrapper |
| `sessionManager.ts` | Session metadata and history helpers |
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
6. **Sessions persist** - Queries resume the active session unless `/new` is used

## 🚫 Anti-Patterns to Avoid

- ❌ Modifying state directly
- ❌ Multiple setState calls for related changes
- ❌ Objects/arrays in useEffect deps without useMemo
- ❌ Forgetting .js extension in imports
- ❌ Running dev server with stale dist/
- ❌ Skipping tests for "simple" changes
- ❌ Hardcoding kubectl commands without --context flag
