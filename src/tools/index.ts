/**
 * Canonical list of all built-in tool plugins.
 *
 * Both entry points that expose Heimdall's tools — the main agent
 * (src/agents/heimdall.ts) and the MCP server (src/mcp-mode.ts) — build their
 * tool registry from this single array, so the two surfaces can never drift
 * out of sync on which tools exist.
 *
 * To add a new tool: implement the factory in src/tools/<name>.ts, export a
 * ToolPlugin from that file, and append it here (plus a matching key in
 * src/lib/config.ts).
 */
import type { ToolPlugin } from '../lib/plugin.ts';
import { kubectlPlugin } from './kubectl.ts';
import { listContextsPlugin, listNamespacesPlugin } from './kubeconfig.ts';
import { helmReleasePlugin } from './helm.ts';
import { prometheusPlugin } from './prometheus.ts';
import { awsCliPlugin } from './aws.ts';
import { trivyScanPlugin } from './trivy.ts';
import { kubecostPlugin } from './kubecost.ts';
import { lokiPlugin } from './loki.ts';
import { jaegerPlugin } from './jaeger.ts';
import { datadogPlugin } from './datadog.ts';
import { newRelicPlugin } from './newrelic.ts';
import { cdkPlugin } from './cdk.ts';

export const ALL_TOOL_PLUGINS: ToolPlugin[] = [
  kubectlPlugin,
  listContextsPlugin,
  listNamespacesPlugin,
  helmReleasePlugin,
  prometheusPlugin,
  awsCliPlugin,
  trivyScanPlugin,
  kubecostPlugin,
  lokiPlugin,
  jaegerPlugin,
  datadogPlugin,
  newRelicPlugin,
  cdkPlugin,
];
