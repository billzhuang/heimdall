# Heimdall

AI-powered SRE agent for EKS health checks using the Claude Agent SDK.

Heimdall performs comprehensive health checks on your EKS clusters, identifies issues, and suggests fixes for human execution.

## Features

- **Smoke Mode** (Default, ~30s) - Quick checks: Node health, Critical pod failures, Recent warning events
- **All Mode** (~2-3min) - Comprehensive: All 10 health check categories
- **Interactive Mode** - Prompts for cluster, context, namespace, mode, and model selection
- **Cluster Connectivity** - Verify control plane access
- **Node Health** - NotReady, MemoryPressure, DiskPressure, resource overcommitment
- **Pod Health** - CrashLoopBackOff, Pending, Failed, OOMKilled, high restarts
- **Deployment Health** - Replica mismatch, stuck rollouts
- **Service Health** - Missing endpoints, LoadBalancer issues
- **Events** - Warning events analysis
- **Helm Releases** - Failed, pending, stuck rollbacks
- **ConfigMaps & Secrets** - Missing references, large configs, cert expiry
- **Storage (PVC/PV)** - Pending PVCs, Released/Failed PVs
- **Jobs & CronJobs** - Failed jobs, missed schedules

## Prerequisites

- Node.js 18+
- `kubectl` configured with access to your EKS cluster
- `ANTHROPIC_API_KEY` environment variable

## Installation

```bash
# Clone the repository
git clone https://github.com/your-username/heimdall.git
cd heimdall

# Install dependencies
npm install

# Set up environment variable
export ANTHROPIC_API_KEY="your-api-key-here"
```

## Usage

### Interactive Mode (Recommended)

Run the check command without flags to enter interactive mode:

```bash
# Easiest - use the interactive script
npm run interactive

# Or build and run the production version
npm run build
npm start -- check
```

You'll be prompted to select:
- **Kubernetes context** (from your kubeconfig)
- **Cluster name**
- **Namespace** to check
- **Health check mode** (smoke or comprehensive)
- **Model** to use (Sonnet, Opus, or Haiku)

Interactive mode example:
```
Welcome to Heimdall - EKS Health Check Agent

📁 Kubeconfig: /Users/user/.kube/config

Available contexts:
  1. arn:aws:eks:us-east-1:123456789:cluster/prod-cluster [current]
  2. arn:aws:eks:us-west-2:987654321:cluster/staging-cluster

? Select context (enter number or press Enter for current): 1
? Enter cluster name: prod-cluster

Namespace to check:
  1. All namespaces
  2. Select from available namespaces
  3. Type a specific namespace
? Select option (1-3): [1] 2

Available namespaces:
  1. default
  2. kube-system
  3. kube-public
  4. my-app
  5. monitoring
? Select namespace (1-5): 4

Health check mode:
  1. Smoke - Quick health check
     Node health, critical pod failures, recent warning events (~30s)
  2. All - Comprehensive check
     All 10 categories: nodes, pods, deployments, services, events, helm, configs, storage, jobs (~2-3min)

? Select mode (1-2): [1] 1

? Select model:
  1. Sonnet - Recommended
  2. Opus - Most capable
  3. Haiku - Fastest
  4. GPT - OpenAI
  5. Gemini - Google
? Choice (1-5): [1] 1

🔍 Starting health check for cluster: prod-cluster
```

### Automated Mode (CI/CD)

For automation, provide all flags explicitly:

```bash
# Quick smoke check (default)
npm run dev -- check --cluster <cluster-name> --context <k8s-context>

# Comprehensive check
npm run dev -- check --cluster <cluster-name> --context <k8s-context> --mode all

# Check specific namespace
npm run dev -- check --cluster my-cluster --context my-context -n my-namespace

# Verbose mode (shows kubectl commands)
npm run dev -- check --cluster my-cluster --context my-context -v

# Select a model (shorthand)
npm run dev -- check --cluster my-cluster --context my-context --model opus

# Select a model (full ID)
npm run dev -- check --cluster my-cluster --context my-context --model claude-opus-4-5-20251101

# Post-report interactive Q&A
npm run dev -- check --cluster my-cluster --context my-context --interactive
```

### CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `-c, --cluster <name>` | EKS cluster name (interactive if not provided) | - |
| `--context <name>` | Kubernetes context to use | - |
| `-k, --kubeconfig <path>` | Path to kubeconfig file | `~/.kube/config` |
| `-n, --namespace <name>` | Namespace to check | `all` |
| `--mode <type>` | Health check mode: `smoke` (quick) or `all` (comprehensive) | `smoke` |
| `-m, --model <name>` | Model to use: `sonnet`, `opus`, `haiku`, or full model ID | `sonnet` |
| `-v, --verbose` | Show verbose output including commands | `false` |
| `--interactive` | Enable post-report interactive Q&A | `false` |
| `--interactive-transcript <path>` | Write interactive transcript to path (JSONL) | - |

## Health Check Modes

### Smoke Mode (Default, ~30 seconds)

Quick validation of cluster health. Checks:
- **Node Health**: NotReady nodes, MemoryPressure, DiskPressure
- **Critical Pod Failures**: CrashLoopBackOff, ImagePullBackOff, Pending
- **Recent Warning Events**: Last 20 events for immediate issues

Use for: Quick validation, pre-deployment checks, monitoring

```bash
npm run dev -- check --cluster my-cluster --context my-context --mode smoke
# Or simply omit --mode (smoke is default)
npm run dev -- check --cluster my-cluster --context my-context
```

### All Mode (~2-3 minutes)

Comprehensive health check covering all 10 categories:
1. Cluster connectivity
2. Node health
3. Pod health
4. Deployment health
5. Service health
6. Recent warning events
7. Helm releases
8. ConfigMaps & Secrets
9. Storage (PVC/PV)
10. Jobs & CronJobs

Use for: Deep troubleshooting, regular audits, post-incident analysis

```bash
npm run dev -- check --cluster my-cluster --context my-context --mode all
```

## Output

Heimdall provides:

1. **Real-time progress** - See each check as it runs
2. **Issue detection** - CRITICAL and WARNING severity levels
3. **Root cause analysis** - Explains why issues are happening
4. **Suggested fixes** - kubectl commands and YAML manifests
5. **Summary report** - Overall cluster health assessment

### Example Output

```
🔍 Starting health check for cluster: my-cluster

✓ Agent initialized
  Model: claude-sonnet-4-20250514
  Tools: Bash

🔧 Running: Bash
   Check EKS cluster connectivity
   $ kubectl --context=my-context cluster-info

🔧 Running: Bash
   Check all node health status
   $ kubectl --context=my-context get nodes -o wide

...

## Summary

| Category | Critical | Warnings |
|----------|----------|----------|
| Nodes    | 0        | 1        |
| Pods     | 0        | 0        |

✅ Health check complete

Cost: $0.50
Duration: 120s
```

## Development

```bash
# Type check
npm run typecheck

# Build
npm run build

# Run built version
npm start -- check --cluster my-cluster
```

## How It Works

Heimdall uses the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents) to:

1. Run kubectl/helm commands via the built-in Bash tool
2. Analyze output using Claude's understanding of Kubernetes
3. Identify issues and determine severity
4. Generate actionable fix suggestions

The agent operates in **advisory mode** - it only runs read-only commands and suggests fixes for you to review and execute.

## License

MIT
