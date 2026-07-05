import { describe, it, expect, vi } from 'vitest';

// Mock config so we don't need a real heimdall.config.yaml — mirrors the mock
// used in src/lib/__tests__/mcp-mode.test.ts, which wires up the same 13 tool
// plugins on the MCP server side.
vi.mock('../../lib/config.ts', () => ({
  loadConfig: () => ({
    tools: {
      kubectl: true,
      listContexts: true,
      listNamespaces: true,
      helmRelease: true,
      prometheusQuery: false,
      awsCli: false,
      trivyScan: false,
      kubecostQuery: false,
      lokiQuery: false,
      jaegerQuery: false,
      datadogQuery: false,
      newRelicQuery: false,
      cdkQuery: false,
    },
    redaction: null,
    namespace: null,
    audit: null,
    redactSecrets: false,
    prometheus: null,
    kubecost: null,
    loki: null,
    jaeger: null,
    datadog: null,
    newRelic: null,
    slos: [],
    runbooks: [],
    learning: null,
    telemetry: { enabled: false },
    otel: { enabled: false },
  }),
}));

import heimdall, { description } from '../heimdall.ts';

describe('heimdall agent tool wiring', () => {
  it('enables exactly the tools turned on in config, across all built-in plugins', () => {
    // heimdall.ts's initializer ignores its AgentInitializerContext argument
    // entirely, so a no-arg call is safe at runtime despite the wider type.
    const initialize = heimdall.initialize as () => { tools?: Array<{ name: string }> };
    const runtime = initialize();
    const names = (runtime.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(['helm_release', 'kubectl', 'list_contexts', 'list_namespaces'].sort());
  });

  it('exposes a static description', () => {
    expect(description).toContain('Kubernetes');
  });
});
