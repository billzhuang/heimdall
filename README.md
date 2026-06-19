# Heimdall

AI-powered, **read-only** Kubernetes SRE agent built on the [Flue](https://flueframework.com) agent framework.

Heimdall helps SREs and developers diagnose Kubernetes issues faster by combining `kubectl` with AI reasoning. It runs entirely in advisory mode: it can investigate a cluster but can never mutate it.

## Features

- **Read-only by construction** — cluster access flows through a single `kubectl` tool that mechanically blocks every state-changing or code-executing subcommand (`apply`, `delete`, `patch`, `exec`, `port-forward`, …). Mixed command families are gated by nested verb: `kubectl auth` allows only `can-i`/`whoami`, and `kubectl config` is blocked entirely.
- **Specialist subagents** — delegates deep investigations to focused profiles: `log-analyzer`, `resource-analyzer`, `network-debugger`, `security-auditor`.
- **Cluster discovery** — `list_contexts` and `list_namespaces` tools let it find what's available.
- **kubectl JSON cache** — short‑TTL on-disk cache for `kubectl get … -o json` to avoid hammering the API server during tight diagnostic loops.
- **Deploy anywhere** — Flue agents run locally via the CLI or deploy to Node.js, Cloudflare, and more.

## Prerequisites

- **Node.js ≥ 22.19.0** (required by Flue)
- `kubectl` configured with access to your cluster
- `ANTHROPIC_API_KEY` in your environment

## Setup

```bash
npm install
cp .env.example .env   # then set ANTHROPIC_API_KEY
```

## Usage

### One-shot mode

Send a single prompt and exit — useful in scripts, CI, and ad-hoc investigations:

```bash
npm run prompt -- -p "Why is my api pod crash-looping in prod?"
```

After `npm install -g` (or `npm link`), the `heimdall` binary is available directly:

```bash
heimdall -p "Why is my api pod crash-looping in prod?"
heimdall -p "List all deployments with fewer than 2 replicas"
heimdall -p "Audit RBAC for the payments service account"
heimdall --help
```

### Interactive mode

For back-and-forth investigation sessions:

```bash
npm run connect          # = flue connect heimdall local --target node
```

```text
[flue] Connected to heimdall/local. Enter a prompt per line; Ctrl-D to exit.
why is my api pod in CrashLoopBackOff? namespace prod
```

Run the dev server (HTTP + hot reload), or build a deployable artifact:

```bash
npm run dev              # flue dev --target node
npm run build            # flue build --target node  -> dist/
```

### Example prompts

```text
check pdb configuration in kube-system
list all deployments with fewer than 2 replicas
explain the network policies in the payments namespace
audit RBAC for the default service account
```

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Purpose | Default |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Provider credential (required) | — |
| `HEIMDALL_MODEL` | Flue `provider/model` specifier | `anthropic/claude-sonnet-4-6` |
| `KUBECONFIG` | Path to kubeconfig | `~/.kube/config` |
| `HEIMDALL_CONTEXT` | Pin a default cluster context | current-context |
| `HEIMDALL_NAMESPACE` | Pin a default namespace | — |
| `HEIMDALL_KUBECTL_CACHE` | Set to `0` to disable the JSON cache | enabled |
| `HEIMDALL_KUBECTL_CACHE_TTL` | Cache TTL in seconds | `30` |
| `HEIMDALL_KUBECTL_CACHE_DIR` | Override cache directory | OS temp dir |

## Project layout

```
src/
├── agents/
│   └── heimdall.ts      # the agent (default export) + read-only subagents
├── tools/
│   ├── kubectl.ts       # read-only kubectl tool
│   └── kubeconfig.ts    # list_contexts / list_namespaces tools
└── lib/
    ├── kubectl-safety.ts # pure read-only policy (parse + validate)
    ├── kubectl.ts        # command execution (no shell) + JSON cache
    ├── kubeconfig.ts     # kubeconfig parsing + namespace listing
    ├── instructions.ts   # system + subagent instructions
    ├── model.ts          # default model specifier
    └── __tests__/        # unit + property-based tests
flue.config.ts           # Flue build config (target: node)
```

## Development

```bash
npm run typecheck        # tsc --noEmit
npm test                 # vitest
npm run test:coverage    # coverage report
npm run build            # build deployable artifact
```

## Safety model

The read-only guarantee is enforced in code, not just in the prompt:

1. The agent's **only** cluster tool is `kubectl`, which calls `validateCommand` on the exact tokenized command before running anything. It is **default-deny**: only an explicit allow-list of read-only subcommands passes, everything else (including unknown subcommands) is blocked.
2. Command families that mix read-only and mutating verbs are gated by nested verb — `auth` permits only `can-i`/`whoami` (e.g. `auth reconcile` is blocked), and `config` (which can mutate the kubeconfig or expose credentials) is blocked entirely. Use the `list_contexts` tool for context discovery instead.
3. Commands are executed with `execFile` (no shell), so model-supplied arguments cannot inject pipes, redirects, or command substitution.
4. The default in-memory sandbox keeps the model's general shell off the host — real cluster access only happens through the validated tool.
5. The JSON cache is keyed by the full argv plus kubeconfig and effective context, and stored in a per-user directory, so reads can't collide or leak across clusters or users.

The policy is covered by unit and property-based tests (`fast-check`) asserting these invariants hold for all inputs.

## License

MIT
