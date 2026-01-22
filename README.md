# Heimdall

AI-powered Kubernetes assistant and SRE agent using the Claude Agent SDK.

Heimdall is an interactive TUI for Kubernetes diagnostics - ask questions in natural language and get intelligent answers powered by AI.

## Features

- **Interactive TUI** - Natural language interface for K8s diagnostics
- **Auto-load Context** - Automatically uses current-context from kubeconfig
- **Multi-Model Support** - Claude Sonnet/Opus/Haiku, GPT, Gemini
- **Web Search** - Search for error messages, CVEs, deprecated APIs
- **Cancellable Queries** - Press ESC to cancel running queries
- **Thinking Summary** - Each response includes a brief high-level reasoning summary
- **Kubectl JSON Cache** - Short TTL cache reduces repeated `kubectl get -o json` calls

## Prerequisites

- Node.js 18+
- `kubectl` configured with access to your Kubernetes cluster
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

```text
heimdall> check pdb configuration
heimdall> why is my pod in CrashLoopBackOff?
heimdall> list all deployments with less than 2 replicas
heimdall> explain the network policies in this namespace
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

1. Run kubectl commands via the built-in Bash tool
2. Search the web for error messages and documentation
3. Analyze output using AI understanding of Kubernetes
4. Provide focused answers to your specific questions

The agent operates in **advisory mode** - it runs read-only commands and provides information to help you make decisions.

## License

MIT
