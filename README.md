# Heimdall

AI-powered SRE agent for EKS health checks using the Claude Agent SDK.

Heimdall performs comprehensive health checks on your EKS clusters, identifies issues, and suggests fixes for human execution.

## Features

- **Interactive Chat Mode** - Natural language commands for health checks
- **Smoke Mode** (~30s) - Quick checks: Node health, Critical pod failures, Recent warning events
- **All Mode** (~2-3min) - Comprehensive: All 10 health check categories
- **Follow-up Questions** - Ask questions about results after each check
- **Multi-Model Support** - Sonnet, Opus, Haiku, GPT, Gemini

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

```bash
# Development
npm run interactive

# Or build and run
npm run build
npm start
```

### Initial Setup

On launch, you'll be prompted to select:
- **Kubernetes context** (from your kubeconfig)
- **Cluster name**
- **Namespace** to check

### Chat Commands

Once setup is complete, use natural language commands:

```
heimdall> run quick check
heimdall> comprehensive check with opus
heimdall> run check with haiku
heimdall> help
heimdall> exit
```

Available models: `sonnet` (default), `opus`, `haiku`, `gpt`, `gemini`

### CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `-k, --kubeconfig <path>` | Path to kubeconfig file | `~/.kube/config` |
| `-v, --verbose` | Show verbose output including commands | `false` |
| `--transcript <path>` | Write session transcript to path (JSONL) | - |

## Health Check Modes

### Smoke Mode (~30 seconds)

Quick validation of cluster health:
- **Node Health**: NotReady nodes, MemoryPressure, DiskPressure
- **Critical Pod Failures**: CrashLoopBackOff, ImagePullBackOff, Pending
- **Recent Warning Events**: Last 20 events for immediate issues

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

## Output

Heimdall provides:

1. **Real-time progress** - See each check as it runs
2. **Issue detection** - CRITICAL and WARNING severity levels
3. **Root cause analysis** - Explains why issues are happening
4. **Suggested fixes** - kubectl commands and YAML manifests
5. **Follow-up Q&A** - Ask questions about the results

## Development

```bash
npm run typecheck  # Type check
npm run build      # Build
npm start          # Run built version
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
