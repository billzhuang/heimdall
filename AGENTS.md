# Heimdall — AI Agent Guidelines

> This document helps AI assistants understand and contribute to Heimdall effectively.

## 🎯 Project Overview

Heimdall is an AI-powered, **read-only** Kubernetes SRE agent built on the
[Flue](https://flueframework.com) agent framework. It diagnoses cluster issues by
combining `kubectl` with AI reasoning, and operates strictly in advisory mode.

**Core value:** help SREs and developers diagnose K8s issues faster, safely.

## 🏗️ Architecture

Heimdall is a Flue project. Flue discovers agents from `src/agents/`; everything
else is ordinary supporting code that the agent imports.

```
src/
├── agents/
│   └── heimdall.ts      # default export = the `heimdall` agent + subagents
├── tools/
│   ├── kubectl.ts       # read-only kubectl tool (defineTool + valibot)
│   └── kubeconfig.ts    # list_contexts / list_namespaces tools
└── lib/
    ├── kubectl-safety.ts # PURE read-only policy: parseKubectlCommand, validateCommand
    ├── kubectl.ts        # runKubectl: tokenize (no shell) + exec + JSON cache
    ├── kubeconfig.ts     # kubeconfig parsing + fetchNamespaces
    ├── instructions.ts   # buildInstructions() + SUBAGENT_INSTRUCTIONS
    ├── model.ts          # DEFAULT_MODEL
    └── __tests__/        # unit + property-based tests
flue.config.ts           # defineConfig({ target: 'node' })
```

## 🔧 Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js ≥ 22.19.0 (ESM) |
| Language | TypeScript 5.x (strict) |
| Agent framework | Flue (`@flue/runtime`, `@flue/cli`) |
| Schemas | valibot |
| Config parsing | js-yaml |
| Testing | Vitest + fast-check (property-based) |
| Build | `flue build` (CLI bundles `dist/server.mjs`) |

## 📋 Commands

```bash
npm run dev          # flue dev --target node (HTTP + hot reload)
npm run connect      # flue connect heimdall local (interactive)
npm run build        # flue build --target node -> dist/
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run test:coverage
```

## ⚠️ Critical Rules

### 1. Read-only is enforced in code
The read-only guarantee does **not** depend on the prompt:
- `src/lib/kubectl-safety.ts#validateCommand` is the single source of truth for
  which subcommands are allowed. It is **default-deny**: anything not on
  `ALLOWED_KUBECTL_COMMANDS` is blocked, and everything on
  `DESTRUCTIVE_KUBECTL_COMMANDS` is always blocked.
- The `kubectl` tool calls `validateCommand` before executing anything.
- Never weaken this policy. If you add an allowed subcommand, it must be
  genuinely read-only, and you must add tests.

### 2. No shell execution
`runKubectl` tokenizes arguments and runs `kubectl` via `execFile` (no shell).
This makes model-supplied arguments injection-safe — do not switch to `exec`/
shell strings, and do not introduce pipe/redirect handling.

### 3. Tools are the boundary, not just helpers
Cluster capabilities are exposed exclusively as Flue tools (`defineTool`). Build
parameter schemas with valibot (`v.object({ ... })`). A tool's parameters are
model-selected inputs, never an authorization boundary — trusted code decides
what a tool may touch.

### 4. Import style
Inside `src/`, import local modules with the `.ts` extension (Flue's bundler and
`moduleResolution: "bundler"` resolve them), e.g. `import { runKubectl } from
'../lib/kubectl.ts'`. Import framework packages by name (`@flue/runtime`).

### 5. Models
Use Flue `provider/model` specifiers (e.g. `anthropic/claude-sonnet-4-6`).
Provider credentials come from the environment (`ANTHROPIC_API_KEY`); do not
register providers in `flue.config.ts`. Override the model with `HEIMDALL_MODEL`.

### 6. Response format
The agent always answers in two sections — a brief high-level **Thinking
Summary** and a full **Answer** — and never reveals hidden chain-of-thought.
This lives in `src/lib/instructions.ts`.

## 🧪 Testing Strategy

- **Pure logic** (`kubectl-safety`, `kubeconfig`, tokenizer/cache helpers): unit tests.
- **Property-based tests** (fast-check): the read-only policy must hold for all
  inputs — destructive subcommands always blocked, non-kubectl always rejected,
  even behind value-taking global flags (e.g. `kubectl --v 5 delete`).
- Tests live in `src/lib/__tests__/*.test.ts`. Keep them free of cluster/network
  dependencies (no live `kubectl`).

## 🔄 Common Workflows

### Add a new tool
1. Create/extend a module in `src/tools/` using `defineTool` + valibot.
2. If it runs `kubectl`, route execution through `runKubectl` so the read-only
   policy and cache apply.
3. Add it to the `clusterTools` array in `src/agents/heimdall.ts`.
4. Add tests for any new pure logic.

### Add a subagent
1. Add instructions to `SUBAGENT_INSTRUCTIONS` in `src/lib/instructions.ts`.
2. Create a `defineAgentProfile(...)` in `src/agents/heimdall.ts` and add it to
   the `subagents` array. Give it the read-only `clusterTools`.

### Change allowed/blocked kubectl subcommands
1. Edit `ALLOWED_KUBECTL_COMMANDS` / `DESTRUCTIVE_KUBECTL_COMMANDS` in
   `src/lib/kubectl-safety.ts`.
2. Update tests (including the property tests) to cover the change.

## 🚫 Anti-Patterns to Avoid

- ❌ Running kubectl through a shell or accepting raw shell strings.
- ❌ Bypassing `validateCommand` / `runKubectl` for cluster access.
- ❌ Putting credentials or tenant identifiers in model-selected tool arguments.
- ❌ Adding a subcommand to the allow-list without tests.
- ❌ Forgetting the `.ts` extension on local imports inside `src/`.
- ❌ Committing `.env` or provider credentials.
