# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview
- Heimdall is a CLI SRE agent for EKS health checks using the Claude Agent SDK.
- The agent runs read-only kubectl/helm diagnostics and produces a health report with suggested fixes.

## Commands
- Install deps: `npm install`
- Run interactive TUI: `npm run dev`
- Run with verbose output: `npm run dev -- --verbose`
- Run with custom kubeconfig: `npm run dev -- --kubeconfig /path/to/config`
- Typecheck: `npm run typecheck`
- Build: `npm run build`
- Run built CLI: `npm start`

## Architecture
- CLI entrypoint: `src/index.ts` - Simple Commander-based CLI that launches the Ink TUI.
- TUI components (src/tui/components/):
  - `App.tsx` - Main app component with session management, command routing, and layout.
  - `WelcomeScreen.tsx` - Initial welcome screen shown on first run.
  - `InputField.tsx` - Input component with autocomplete and Ctrl+C handling.
  - `PromptInput.tsx` - Low-level text input with cursor management.
  - `OutputArea.tsx` - Message display area.
  - `StatusBar.tsx` - Shows current context, namespace, model, session.
  - `*Selector.tsx` - Modal selectors for context, namespace, model, and sessions.
- Agent integration: `src/tui/agentRunner.ts` - Runs Claude Agent SDK queries, manages sessions, streams responses.
- Session management: `src/tui/sessionManager.ts` - Saves/loads conversation history, metadata.
- Kubeconfig parsing: `src/tui/kubeconfigParser.ts` - Extracts contexts and namespaces.

## TUI usage notes
- Requires Node.js 20+, `kubectl` access to the cluster, and `ANTHROPIC_API_KEY` in the environment.
- The TUI provides an interactive REPL for asking Kubernetes questions.
- Slash commands: `/ctx` (context), `/ns` (namespace), `/model`, `/resume`, `/continue`, `/new`, `/clear`, `/help`, `/exit`.
- Sessions are automatically saved and can be resumed later.
- Ctrl+C behavior: Clear input if there's text, quit if input is empty.
- ESC to cancel running queries.

## Claude Code tool usage
- If the built-in web_search tool fails or is unavailable, try using the Tavily MCP server for web search capabilities.
- For querying library documentation and code examples, use the MCP Context7 server (resolve-library-id and query-docs tools).
