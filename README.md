# Heimdall

AI-powered Cloud SRE agent for Kubernetes and AWS operations using the Claude Agent SDK.

Heimdall is an interactive TUI for cloud infrastructure diagnostics - ask questions in natural language and get intelligent answers powered by AI with specialized sub-agents.

## Features

- **Interactive TUI** - Natural language interface for K8s and AWS diagnostics
- **Multi-Capability** - Kubernetes troubleshooting + AWS operations (EKS, IAM, cost analysis, etc.)
- **Specialized Sub-Agents** - Automatic delegation to focused experts (logs, resources, security, costs)
- **Auto-load Context** - Automatically uses current-context from kubeconfig
- **Multi-Model Support** - Claude Sonnet/Opus/Haiku, GPT, Gemini
- **Web Search** - Search for error messages, CVEs, deprecated APIs
- **Cancellable Queries** - Press ESC to cancel running queries
- **Thinking Summary** - Each response includes a brief high-level reasoning summary
- **Safety First** - Built-in command validation blocks destructive operations

## Prerequisites

- Node.js 18+
- `kubectl` configured with access to your Kubernetes cluster
- AWS CLI (optional, for AWS-specific features)
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
npm run dev

# Or build and run
npm run build
npm start
```

### Auto-load Behavior

On launch, Heimdall automatically:
- Loads the `current-context` from your kubeconfig
- Uses the default namespace for that context (or `kube-system` if none)

### Slash Commands

| Command | Description |
|---------|-------------|
| `/ctx` | Switch Kubernetes context |
| `/ns` | Switch namespace |
| `/model` | Change AI model |
| `/resume` | Browse and resume saved sessions |
| `/continue` | Continue most recent session |
| `/rename <name>` | Name current session |
| `/context` | Show current session info |
| `/new` | Start a new session |
| `/clear` | Clear conversation history |
| `/help` | Show available commands |
| `/exit` | Exit Heimdall |

### Example Queries

**Kubernetes:**
```text
heimdall> check pdb configuration
heimdall> why is my pod in CrashLoopBackOff?
heimdall> list all deployments with less than 2 replicas
heimdall> explain the network policies in this namespace
```

**AWS:**
```text
heimdall> check my EKS cluster node groups health
heimdall> audit IAM roles for overly permissive policies
heimdall> analyze my AWS costs for this month
heimdall> list all EC2 instances in us-west-2
heimdall> check service quotas for EKS
```

**Combined:**
```text
heimdall> why is my EKS node failing to join the cluster?
heimdall> check if my K8s service account has the right IAM permissions
```

### CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `-k, --kubeconfig <path>` | Path to kubeconfig file | `~/.kube/config` |
| `-v, --verbose` | Show verbose output including tool calls | `false` |

### Session Memory

Heimdall resumes the active session by default, so short follow-ups like "3" keep context.
Use `/new` to start fresh, or `/resume`/`/continue` to switch sessions.

### Kubectl Cache

By default, Heimdall caches `kubectl get ... -o json` outputs for 30 seconds to reduce
repeat API calls in tight tool loops.

Environment variables:

```bash
HEIMDALL_KUBECTL_CACHE=0        # disable cache
HEIMDALL_KUBECTL_CACHE_TTL=30   # TTL in seconds (default: 30)
HEIMDALL_KUBECTL_CACHE_DIR=/tmp # override cache directory
```

## Development

```bash
npm run dev        # Run in development mode
npm run typecheck  # Type check
npm run build      # Build
npm test           # Run tests
npm run test:coverage  # Run tests with coverage
```

## How It Works

Heimdall uses the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents) to:

1. Run kubectl and AWS CLI commands via the built-in Bash tool
2. Search the web for error messages and documentation
3. Analyze output using AI understanding of Kubernetes and AWS
4. Automatically delegate complex tasks to specialized sub-agents
5. Provide focused answers to your specific questions

The agent operates in **advisory mode** - it runs read-only commands and provides information to help you make decisions.

### Specialized Sub-Agents

Heimdall automatically delegates work to focused sub-agents based on the query:

**Kubernetes Sub-Agents:**
- **log-analyzer** - Deep log analysis and error correlation
- **resource-analyzer** - CPU/memory optimization and capacity planning
- **network-debugger** - DNS, services, and connectivity issues
- **security-auditor** - RBAC, secrets, and security contexts
- **web-researcher** - CVE lookup and documentation search

**AWS Sub-Agents:**
- **eks-troubleshooter** - EKS cluster and node group diagnostics
- **aws-cli-analyzer** - AWS resource inventory and configuration checks
- **iam-auditor** - IAM security audits and permission analysis
- **cost-analyzer** - Cost optimization and billing insights
- **service-health-checker** - Service health, quotas, and limits

Each sub-agent has:
- Specialized expertise in its domain
- Access only to tools it needs (least privilege)
- Isolated context to prevent information overload
- Built-in safety checks to prevent destructive operations

## License

MIT
