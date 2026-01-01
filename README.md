# Heimdall

AI-powered SRE agent for EKS health checks using the Claude Agent SDK.

Heimdall performs comprehensive health checks on your EKS clusters, identifies issues, and suggests fixes for human execution.

## Features

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
- [Claude Code CLI](https://claude.ai/code) installed
- `kubectl` configured with access to your EKS cluster
- `ANTHROPIC_API_KEY` environment variable

## Installation

```bash
# Clone the repository
git clone https://github.com/your-username/heimdall.git
cd heimdall

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
```

## Usage

```bash
# Run health check
npm run dev -- check --cluster <cluster-name> --context <k8s-context>

# Example
npm run dev -- check --cluster my-cluster --context arn:aws:eks:us-east-1:123456789:cluster/my-cluster

# Check specific namespace
npm run dev -- check --cluster my-cluster --context my-context -n my-namespace

# Verbose mode (shows kubectl commands)
npm run dev -- check --cluster my-cluster --context my-context -v

# Select a model (shorthand)
npm run dev -- check --cluster my-cluster --context my-context --model opus

# Select a model (full ID)
npm run dev -- check --cluster my-cluster --context my-context --model claude-opus-4-5-20251101
```

### CLI Options

| Option | Description |
|--------|-------------|
| `-c, --cluster <name>` | EKS cluster name (required) |
| `--context <name>` | Kubernetes context to use |
| `-k, --kubeconfig <path>` | Path to kubeconfig file |
| `-n, --namespace <name>` | Namespace to check (default: all) |
| `-v, --verbose` | Show verbose output including commands |
| `-m, --model <name>` | Model to use (sonnet, opus, haiku, or full model ID) |

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
