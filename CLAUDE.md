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
│   └── heimdall.ts          # default export = the `heimdall` agent + subagents
├── tools/
│   ├── kubectl.ts           # read-only kubectl tool (defineTool + valibot)
│   ├── kubeconfig.ts        # list_contexts / list_namespaces tools
│   ├── helm.ts              # helm_release tool (list/status/get)
│   ├── prometheus.ts        # prometheus_query tool (PromQL)
│   ├── aws.ts               # aws_cli tool (read-only AWS CLI)
│   ├── trivy.ts             # trivy_scan tool (CVE/misconfiguration scanning)
│   ├── kubecost.ts          # kubecost_query tool (cost attribution)
│   ├── loki.ts              # loki_query tool (Grafana Loki / LogQL)
│   ├── jaeger.ts            # jaeger_query tool (Jaeger / Tempo traces)
│   └── datadog.ts           # datadog_query tool (metrics/logs/events/monitors)
└── lib/
    ├── kubectl-safety.ts    # PURE read-only policy: parseKubectlCommand, validateCommand
    ├── kubectl.ts           # runKubectl: tokenize (no shell) + exec + JSON cache
    ├── aws-safety.ts        # PURE read-only policy for AWS CLI commands
    ├── aws.ts               # runAwsCli: tokenize + exec (no shell) + output cap
    ├── trivy-safety.ts      # PURE read-only policy for Trivy scans
    ├── trivy.ts             # runTrivy: exec + output cap
    ├── kubeconfig.ts        # kubeconfig parsing helpers
    ├── helm.ts              # Helm release inspection (exec, no shell)
    ├── prometheus.ts        # Prometheus HTTP API client
    ├── kubecost.ts          # Kubecost HTTP API client
    ├── loki.ts              # Grafana Loki HTTP API client
    ├── jaeger.ts            # Jaeger / Grafana Tempo HTTP API client
    ├── datadog.ts           # Datadog API client
    ├── config.ts            # loadConfig() + HeimdallConfig schema (valibot)
    ├── instructions.ts      # buildInstructions() + SUBAGENT_INSTRUCTIONS
    ├── model.ts             # DEFAULT_MODEL
    ├── audit.ts             # optional command audit log (tool calls → file/stderr)
    ├── redact.ts            # structural Secret redaction (kubectl .data/.stringData)
    ├── regex-redact.ts      # user-defined regex redaction rules
    ├── runbooks.ts          # local markdown runbook loader
    ├── rag.ts               # MMR diversity selection + RAG context builder
    ├── task-history.ts      # past-task JSONL log helpers
    ├── self-improve.ts      # self-improvement reflection/scoring logic
    ├── self-loop.ts         # automated eval → reflect → patch → re-score loop
    ├── eval-runner.ts       # eval scenario runner (mock kubectl, score)
    ├── format-output.ts     # shared output formatting helpers
    ├── harness.ts           # one-shot / eval harness runner
    ├── triage.ts            # triage-mode orchestration (nodes→pods→…→jobs)
    ├── watch.ts             # watch-mode: K8s Warning event monitor loop
    ├── alert.ts             # alert-mode: PagerDuty webhook + diagnosis dispatch
    ├── slack.ts             # Slack Block Kit notification sink
    ├── duration.ts          # human-readable duration helpers
    ├── claude-cli-llm.ts    # claude CLI adapter for eval/self-improve harness
    ├── codex-cli-llm.ts     # codex CLI adapter for eval/self-improve harness
    └── __tests__/           # unit + property-based tests
├── alert-mode.ts            # CLI entry point for alert / PagerDuty mode
├── eval-mode.ts             # CLI entry point for eval mode
├── format-json.ts           # --json output formatter
├── self-improve-mode.ts     # CLI entry point for self-improve mode
├── self-loop-mode.ts        # CLI entry point for self-loop mode
├── triage-mode.ts           # CLI entry point for triage mode
└── watch-mode.ts            # CLI entry point for watch mode
flue.config.ts               # defineConfig({ target: 'node' })
```

## 🔧 Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js ≥ 22.19.0 (ESM) |
| Language | TypeScript 6.x (strict, `moduleResolution: bundler`) |
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
npm run triage       # whole-cluster health sweep (triage mode)
npm run eval         # run eval scenarios against mock kubectl
```

## ⚠️ Critical Rules

### 1. Read-only is enforced in code
The read-only guarantee does **not** depend on the prompt:
- `src/lib/kubectl-safety.ts#validateCommand` is the single source of truth for
  which kubectl subcommands are allowed. It is **default-deny**: anything not on
  `ALLOWED_KUBECTL_COMMANDS` is blocked, and everything on
  `DESTRUCTIVE_KUBECTL_COMMANDS` is always blocked.
- Command families that mix read-only and mutating verbs are gated by nested
  verb via `NESTED_ALLOWED_VERBS` (e.g. `auth` → only `can-i`/`whoami`; `rollout`
  → only `status`/`history`). `config` is deliberately not allowed at all.
- `runKubectl` validates the **exact tokenized argv** it will execute (it
  tokenizes first, then validates the rejoined command), so validation and
  execution can never diverge.
- `src/lib/aws-safety.ts` enforces an identical default-deny policy for the
  `aws_cli` tool: only `describe-*`, `get-*`, `list-*`, `show-*` subcommands
  pass. This is tested by property-based tests.
- `src/lib/trivy-safety.ts` enforces a read-only allow-list for the `trivy_scan`
  tool (image / fs / config / sbom scan types only).
- Never weaken any safety policy. If you add an allowed subcommand, it must be
  genuinely read-only, and you must add tests.

### 2. No shell execution
`runKubectl` and `runAwsCli` tokenize arguments and run the binary via `execFile`
(no shell). This makes model-supplied arguments injection-safe — do not switch to
`exec`/shell strings, and do not introduce pipe/redirect handling.

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
The agent always answers in structured sections — **Thinking Summary**, **Answer**,
**Causal Chain**, **Evidence**, **Validity Score**, and **Remediation Steps** — and
never reveals hidden chain-of-thought. This lives in `src/lib/instructions.ts`.

### 7. Config-driven tool enablement
All optional tools (Prometheus, AWS, Trivy, Kubecost, Loki, Jaeger, Datadog) are
**disabled by default** and enabled via `heimdall.config.yaml`. The `ALL_TOOLS`
map in `src/agents/heimdall.ts` is typed against `HeimdallConfig['tools']` so the
TypeScript compiler catches any sync drift — adding a config key without a tool
implementation (or vice versa) is a compile error.

## 🧪 Testing Strategy

- **Pure logic** (`kubectl-safety`, `aws-safety`, `trivy-safety`, `kubeconfig`,
  tokenizer/cache helpers): unit tests.
- **Property-based tests** (fast-check): the read-only policy must hold for all
  inputs — destructive subcommands always blocked, non-kubectl always rejected,
  even behind value-taking global flags (e.g. `kubectl --v 5 delete`) and for
  nested verbs (`auth reconcile` blocked, `auth can-i` allowed). Same for AWS CLI.
- Tests live in `src/lib/__tests__/*.test.ts` and `src/tools/__tests__/*.test.ts`.
- **Never spawn a real `kubectl` in tests.** The runners (and CI) have `kubectl`
  installed; an allowed command would try to reach a cluster and hang past the
  test timeout. Assert the *policy decision* against `validateCommand`/the
  blocked paths of `runKubectl` (which return before exec), and **mock
  `runKubectl`** when testing the tool layer (`src/tools/__tests__/tools.test.ts`).
- The same mock-vs-policy split applies to `runAwsCli` and `runTrivy`.

## 🔄 Common Workflows

### Add a new tool
1. Create/extend a module in `src/tools/` using `defineTool` + valibot.
2. If it runs `kubectl`, route execution through `runKubectl` so the read-only
   policy and cache apply. For new binaries, create a matching `*-safety.ts`
   with a pure policy function and property-based tests.
3. Add a key to `ToolsSchema` in `src/lib/config.ts` (default to `false` for
   anything that requires external credentials or binaries).
4. Add the plugin to `ALL_TOOL_PLUGINS` in `src/tools/index.ts` (the shared
   list both the agent and the MCP server build their tool registry from).
5. Add a description line to `buildInstructions()` in `src/lib/instructions.ts`.
6. Add tests for any new pure logic.

### Add a subagent
1. Add instructions to `SUBAGENT_INSTRUCTIONS` and a description to
   `SUBAGENT_DESCRIPTIONS` in `src/lib/instructions.ts`.
2. The subagent is automatically created from the map in `src/agents/heimdall.ts`
   via `Object.keys(SUBAGENT_INSTRUCTIONS).map(defineAgentProfile(...))`.

### Change allowed/blocked kubectl subcommands
1. Edit `ALLOWED_KUBECTL_COMMANDS` / `DESTRUCTIVE_KUBECTL_COMMANDS` (or
   `NESTED_ALLOWED_VERBS` for verbs within a mixed family) in
   `src/lib/kubectl-safety.ts`.
2. Update tests (including the property tests) to cover the change.

### Change allowed AWS CLI subcommands
1. Edit `ALLOWED_AWS_PATTERNS` / `DESTRUCTIVE_AWS_PATTERNS` in
   `src/lib/aws-safety.ts`.
2. Update the property tests in `src/lib/__tests__/aws-safety.property.test.ts`.

## 🚫 Anti-Patterns to Avoid

- ❌ Running kubectl or AWS CLI through a shell or accepting raw shell strings.
- ❌ Bypassing `validateCommand` / `runKubectl` for cluster access.
- ❌ Bypassing `validateAwsCommand` / `runAwsCli` for AWS access.
- ❌ Putting credentials or tenant identifiers in model-selected tool arguments.
- ❌ Adding a subcommand to any allow-list without tests.
- ❌ Spawning a real `kubectl` or `aws` in tests (mock `runKubectl`/`runAwsCli` or
  assert the policy decision instead).
- ❌ Forgetting the `.ts` extension on local imports inside `src/`.
- ❌ Committing `.env` or provider credentials.
- ❌ Adding an optional tool without a matching config key in `HeimdallConfig['tools']`.
- ❌ Enabling a tool by default that requires external credentials/binaries.
