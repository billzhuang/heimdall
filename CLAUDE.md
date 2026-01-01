# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview
- Heimdall is a CLI SRE agent for EKS health checks using the Claude Agent SDK.
- The agent runs read-only kubectl/helm diagnostics and produces a health report with suggested fixes.

## Commands
- Install deps: `npm install`
- Run in dev: `npm run dev -- check --cluster <cluster-name> --context <k8s-context>`
- Run with model override: `npm run dev -- check --cluster <cluster-name> --context <k8s-context> --model opus`
- Typecheck: `npm run typecheck`
- Build: `npm run build`
- Run built CLI: `npm start -- check --cluster <cluster-name>`

## Architecture
- CLI entrypoint: `src/index.ts` defines the `check` command (Commander), parses flags, loads config, validates inputs, and calls `runHealthCheck`.
- Agent runtime: `src/agent.ts` builds the system prompt, configures the model/namespace, streams Claude responses, logs tool usage, and prints the final summary.
- Prompts: `src/prompts.ts` contains the system and task prompts used by the agent.
- Config resolution: `src/config.ts` loads kubeconfig/context defaults and validates required inputs (cluster, API key).
- Domain types: `src/types.ts` defines the health report shapes and agent message types used across the runtime.

## CLI usage notes (from README)
- Requires Node.js 18+, `kubectl` access to the cluster, and `ANTHROPIC_API_KEY` in the environment.
- Common options: `--context`, `--kubeconfig`, `--namespace`, `--verbose`, `--model` (see README for full CLI option list).
- Model selection uses shorthand mapping (`sonnet`, `opus`, `haiku`) or any full model ID string via `--model`.
