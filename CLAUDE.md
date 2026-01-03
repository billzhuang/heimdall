# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview
- Heimdall is a CLI SRE agent for EKS health checks using the Claude Agent SDK.
- The agent runs read-only kubectl/helm diagnostics and produces a health report with suggested fixes.

## Commands
- Install deps: `npm install`
- Run interactive: `npm run dev -- check` (prompts for cluster, context, namespace, mode, model)
- Run with flags: `npm run dev -- check --cluster <cluster-name> --context <k8s-context> --mode <smoke|all>`
- Quick smoke check: `npm run dev -- check --cluster <cluster-name> --context <k8s-context>`
- Comprehensive check: `npm run dev -- check --cluster <cluster-name> --context <k8s-context> --mode all`
- Run with model override: `npm run dev -- check --cluster <cluster-name> --context <k8s-context> --model opus`
- Typecheck: `npm run typecheck`
- Build: `npm run build`
- Run built CLI: `npm start -- check --cluster <cluster-name>`

## Architecture
- CLI entrypoint: `src/index.ts` defines the `check` command (Commander), parses flags, triggers interactive prompts if no parameters provided, loads config, validates inputs, and calls `runHealthCheck`.
- Interactive module: `src/interactive.ts` provides readline prompts for cluster, context, namespace, mode, and model selection. Parses kubeconfig to show available contexts.
- Agent runtime: `src/agent.ts` builds the system and user prompts based on mode (smoke vs all), configures the model/namespace, streams Claude responses, logs tool usage, and prints the final summary. Supports interactive chat mode for follow-up questions.
- Prompts: `src/prompts.ts` contains the system prompt with kubectl examples. User prompt is built in agent.ts based on health check mode.
- Config resolution: `src/config.ts` loads kubeconfig/context defaults and validates required inputs (cluster, API key).
- Constants: `src/constants.ts` defines model mapping (shorthand to full model IDs) for Sonnet, Opus, Haiku, GPT, and Gemini.
- Types: `src/types.ts` is currently minimal (reserved for future type definitions).

## CLI usage notes (from README)
- Requires Node.js 18+, `kubectl` access to the cluster, and `ANTHROPIC_API_KEY` in the environment.
- Interactive mode: Run `check` without flags to be prompted for all parameters (cluster, context, namespace, mode, model).
- Automated mode: Provide flags explicitly for CI/CD use.
- Health check modes: `smoke` (default, quick) or `all` (comprehensive).
- Common options: `--cluster`, `--context`, `--kubeconfig`, `--namespace`, `--mode`, `--verbose`, `--model` (see README for full list).
- Model selection uses shorthand mapping (`sonnet`, `opus`, `haiku`) or any full model ID string via `--model`.

## Claude Code tool usage
- If the built-in web_search tool fails or is unavailable, try using the Tavily MCP server for web search capabilities.
- For querying library documentation and code examples, use the MCP Context7 server (resolve-library-id and query-docs tools).
