# Heimdall

AI-powered, **read-only** Kubernetes SRE agent built on the [Flue](https://flueframework.com) agent framework.

Heimdall helps SREs and developers diagnose Kubernetes issues faster by combining `kubectl` with AI reasoning. It runs entirely in advisory mode: it can investigate a cluster but can never mutate it.

## Features

- **Read-only by construction** — cluster access flows through a single `kubectl` tool that mechanically blocks every state-changing or code-executing subcommand (`apply`, `delete`, `patch`, `exec`, `port-forward`, …). Mixed command families are gated by nested verb: `kubectl auth` allows only `can-i`/`whoami`, and `kubectl config` is blocked entirely.
- **Specialist subagents** — delegates deep investigations to focused profiles: `log-analyzer`, `resource-analyzer`, `network-debugger`, `security-auditor`, `triage`.
- **Triage mode** — `heimdall triage` runs a structured, repeatable whole-cluster health sweep (nodes → pods → workloads → events → PVCs → jobs) and produces a severity-ranked report (critical / warning / info).
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

#### Machine-readable JSON output

Add `--json` (or `--format json`) to get a structured envelope instead of prose —
ideal for CI gates, alert pipelines, and scripts that need to parse the result:

```bash
heimdall -p "Why is my api pod crash-looping?" --json
```

Output (single JSON line):

```json
{
  "summary": "- Checked api deployment in prod\n- Found ImagePullBackOff on new pods\n…",
  "answer": "The `api` deployment is failing because …",
  "severity": "warning",
  "suggestedCommands": [
    "kubectl rollout undo deploy/api -n prod",
    "kubectl describe pod -l app=api -n prod"
  ],
  "model": "anthropic/claude-sonnet-4-6"
}
```

Pipe to `jq` for pretty-printing, or feed directly to scripts:

```bash
# Extract just the severity
heimdall -p "Check the ingress in prod" --json | jq -r '.severity'

# Gate a CI job on diagnosis
result=$(heimdall -p "Are all pods healthy in prod?" --json)
if [[ $(echo "$result" | jq -r '.severity') == "critical" ]]; then
  echo "Critical issue detected — aborting deploy" >&2
  exit 1
fi
```

`--json` is not compatible with `--watch` (watch mode already emits JSON lines) or `triage`.

### Triage mode

Run a structured, whole-cluster health sweep with severity-ranked findings:

```bash
heimdall triage               # sweep the default namespace
heimdall triage -A            # sweep all namespaces
heimdall triage -n prod       # sweep only the prod namespace

npm run triage                # via npm (default namespace)
npm run triage -- -n staging  # scope to a namespace
```

Triage checks, in order:
1. **Nodes** — NotReady status, MemoryPressure, DiskPressure, PIDPressure, Unschedulable
2. **Pods** — CrashLoopBackOff, ImagePullBackOff, OOMKilled, Pending, high restart counts
3. **Workloads** — unavailable replicas in Deployments/StatefulSets/DaemonSets, stuck rollouts
4. **Events** — Warning-type events from the last hour
5. **PVCs** — Pending or Lost persistent volume claims
6. **Jobs** — failed completions or hung jobs

Each finding includes a severity label, a description, and a suggested remediation command. The agent never executes remediation itself.

### Eval mode

Run synthetic RCA scenarios to test agent reasoning accuracy without a real cluster.
kubectl responses are mocked from YAML fixture files in `scenarios/`, so no
kubeconfig or cluster is required.

```bash
heimdall eval                       # run all scenarios
heimdall eval --scenario crashloop  # run only scenarios matching "crashloop"

npm run eval                        # via npm (runs all scenarios)
```

Each scenario YAML file defines:
- A **prompt** sent to the agent (e.g. "Why is my api pod crash-looping?")
- **Mocks** mapping kubectl argument patterns to fixture output
- **Expected keywords** that must appear in the agent's answer
- **Forbidden keywords** that must not appear
- An optional **expected severity** level

Three built-in scenarios ship with Heimdall:

| Scenario | File | Tests |
| --- | --- | --- |
| CrashLoopBackOff / ImagePullBackOff | `scenarios/crashloop-imagepull.yaml` | Bad image tag, ErrImagePull events |
| OOMKilled | `scenarios/oom-killed.yaml` | Memory limit 128Mi, Exit Code 137 |
| PVC Pending / missing StorageClass | `scenarios/pvc-pending.yaml` | StorageClass "fast-ssd" not found |

Add your own scenarios by creating YAML files in `scenarios/`:

```yaml
description: "human-readable name"
prompt: "Why is my api pod crash-looping?"
mocks:
  "get pods": |
    NAME   READY   STATUS              RESTARTS   AGE
    api-pod-abc   0/1   CrashLoopBackOff   5   10m
  "describe pod": |
    Name: api-pod-abc
    ...
expectedSeverity: warning
expectedKeywords:
  - ImagePullBackOff
  - image
forbiddenKeywords:
  - "I don't know"
```

Mock keys are matched against kubectl argv by token subset: the key `"get pods"` matches
any `kubectl get pods ...` call, regardless of additional flags. The most-specific key
(most tokens) wins when multiple keys match.

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

## Docker deployment

Build the image and run it against your local kubeconfig:

```bash
docker build -t heimdall .
docker run --rm -it \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -v ~/.kube:/home/heimdall/.kube:ro \
  -p 3000:3000 \
  heimdall
```

**Tool configuration in Docker**

The image bundles the repo's `heimdall.config.yaml` at `/app/heimdall.config.yaml`, so
any tool toggles you commit are preserved. To override at runtime without rebuilding:

```bash
# Mount a custom config over the bundled one
docker run ... \
  -v /host/path/heimdall.config.yaml:/app/heimdall.config.yaml:ro \
  heimdall

# Or point to a different path via env var
docker run ... \
  -e HEIMDALL_CONFIG=/config/heimdall.config.yaml \
  -v /host/path/heimdall.config.yaml:/config/heimdall.config.yaml:ro \
  heimdall
```

## Deploy in-cluster

The `deploy/` directory contains ready-to-apply Kubernetes manifests for running
Heimdall inside the cluster it diagnoses.

### RBAC (least-privilege, read-only)

Heimdall needs `get`, `list`, and `watch` on common API resources. Secrets are
excluded from the default role; apply the opt-in extension if you need Helm
release inspection.

```bash
# Recommended: create Namespace + ServiceAccount + ClusterRole (no Secrets) + ClusterRoleBinding
kubectl apply -f deploy/rbac.yaml

# Optional: also grant read access to Secrets (needed for Helm release inspection)
kubectl apply -f deploy/rbac-with-secrets.yaml

# Alternative: scope Heimdall to a single namespace instead of the whole cluster
# (edit the two namespace: fields in the file first)
kubectl apply -f deploy/rbac-namespaced.yaml
```

> **Why no Secrets by default?** Granting an AI agent access to all cluster
> Secrets (credentials, tokens, TLS keys) is a significant blast-radius decision.
> The default role is deliberately secrets-free; apply `rbac-with-secrets.yaml`
> only if you understand and accept that risk.

### Deployment

```bash
# 1. Create the API key Secret
kubectl create secret generic heimdall-api-key \
  --namespace heimdall \
  --from-literal=ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY

# 2. Build and push the image to your registry, then edit image: in deployment.yaml

# 3. Apply
kubectl apply -f deploy/deployment.yaml
```

The Deployment is hardened by default:

| Security control | Setting |
| --- | --- |
| Runs as non-root | `runAsNonRoot: true` |
| No privilege escalation | `allowPrivilegeEscalation: false` |
| Read-only root filesystem | `readOnlyRootFilesystem: true` |
| All Linux capabilities dropped | `capabilities: drop: [ALL]` |
| Seccomp profile | `RuntimeDefault` |
| Writable `/tmp` | `emptyDir` volume (kubectl cache + Node.js temp) |
| In-cluster auth | `automountServiceAccountToken: true` (uses the ServiceAccount above) |

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Purpose | Default |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Provider credential (required) | — |
| `HEIMDALL_MODEL` | Flue `provider/model` specifier | `anthropic/claude-sonnet-4-6` |
| `KUBECONFIG` | Path to kubeconfig | `~/.kube/config` |
| `HEIMDALL_CONFIG` | Path to `heimdall.config.yaml` | `<cwd>/heimdall.config.yaml` |
| `HEIMDALL_KUBECTL_CACHE` | Set to `0` to disable the JSON cache | enabled |
| `HEIMDALL_KUBECTL_CACHE_TTL` | Cache TTL in seconds | `30` |
| `HEIMDALL_KUBECTL_CACHE_DIR` | Override cache directory | OS temp dir |
| `HEIMDALL_KUBECTL_MOCK` | Path to a JSON mock fixture file (eval mode) | — |
| `PROMETHEUS_URL` | Prometheus base URL (overrides `prometheus.url` in config) | — |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook URL (overrides `slack.webhookUrl` in config) | — |

### Slack notification sink

Heimdall can post investigation findings to a Slack channel after a `--json` one-shot run.
**Disabled by default.** To enable, add to `heimdall.config.yaml`:

```yaml
slack:
  enabled: true
  webhookUrl: ${SLACK_WEBHOOK_URL}   # or set the SLACK_WEBHOOK_URL env var
  channel: '#sre-alerts'             # optional — uses the webhook's default channel when omitted
  minSeverity: warning               # only post 'warning' and 'critical' findings (default)
  timeoutMs: 10000                   # optional, default 10000 ms
```

Alternatively, set the `SLACK_WEBHOOK_URL` environment variable and omit `webhookUrl` from the config — the env var is used when the config does not specify a URL.

When a finding is generated via `heimdall -p "..." --json`, a [Block Kit](https://api.slack.com/block-kit) message is posted containing:
- A severity header with emoji (`:rotating_light:` / `:warning:` / `:information_source:`)
- The top 3 key findings from the Thinking Summary
- The agent's full answer (capped at 2 000 characters)
- The top 3 suggested `kubectl` commands (if any)

Failure to post (non-2xx response, network error, timeout) is non-fatal: a warning is logged to stderr and the JSON output is emitted normally.

### Prometheus integration

Heimdall can query Prometheus for time-series metrics (golden signals, resource trends) via PromQL.
It is **disabled by default**. To enable, add to `heimdall.config.yaml`:

```yaml
tools:
  prometheus_query: true   # or prometheusQuery: true

prometheus:
  url: http://prometheus-operated.monitoring:9090   # required
  timeoutMs: 10000                                   # optional, default 10000
```

The base URL can also be set via the `PROMETHEUS_URL` environment variable (takes precedence over config).

The tool supports:
- **Instant queries** — evaluate a PromQL expression at a single point in time (defaults to now).
- **Range queries** — evaluate over a time window with a resolution step (e.g. `step: "1m"`).

Only read-only GET endpoints (`/api/v1/query`, `/api/v1/query_range`) are called.
Results are capped at 20 000 characters to avoid overflowing the model's context.

### Regex redaction

Heimdall already structurally redacts Kubernetes Secret `.data`/`.stringData` values from kubectl output. For broader coverage — API keys that appear in ConfigMaps or pod env vars, bearer tokens in log snippets, PEM headers in Prometheus label values — add user-defined regex rules to `heimdall.config.yaml`:

```yaml
redaction:
  enabled: true
  rules:
    - name: aws_access_key
      pattern: 'AKIA[0-9A-Z]{16}'
    - name: private_key_pem
      pattern: '-----BEGIN( RSA| EC| OPENSSH)? PRIVATE KEY-----'
    - name: generic_token
      pattern: '(?i)(bearer|token|api[_-]?key)["\s:=]+[A-Za-z0-9/+._-]{20,}'
```

**Disabled by default.** When enabled, each rule's `pattern` is compiled as a JavaScript regex (global flag added automatically) and applied to all tool output before it reaches the model. Matches are replaced with `[REDACTED:<name>]`. Patterns are compiled once at startup; an invalid regex is skipped with a warning rather than crashing the agent.

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
