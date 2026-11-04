import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/config.ts', () => ({
  loadConfig: () => ({
    tools: {
      kubectl: true,
      listContexts: true,
      listNamespaces: true,
      helmRelease: false,
      prometheusQuery: true,
      awsCli: false,
      trivyScan: false,
      kubecostQuery: false,
      lokiQuery: false,
      jaegerQuery: false,
      datadogQuery: false,
      newRelicQuery: false,
      cdkQuery: false,
    },
    slos: [
      {
        name: 'api-availability',
        service: 'api',
        namespace: 'prod',
        indicator: 'availability',
        target: '99.9%',
        window: '30d',
      },
    ],
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
    runbooks: [],
    learning: { enabled: false },
    telemetry: { enabled: false },
    otel: { enabled: false },
  }),
  resolveConfigDir: () => process.cwd(),
}));

import triageWorkflow from '../triage.ts';

describe('triage workflow (Pi Durable)', () => {
  it('builds the triage prompt with SLOs and returns the agent report', async () => {
    const promptSpy = vi.fn().mockResolvedValue({
      text: '## Critical\n- Pod api-0 CrashLoopBackOff in prod',
    });

    const result = await triageWorkflow.execute(
      { namespace: 'prod' },
      {
        harness: {
          session: async () => ({
            prompt: promptSpy,
          }),
        },
      },
    );

    expect(result).toEqual({
      report: '## Critical\n- Pod api-0 CrashLoopBackOff in prod',
    });
    expect(promptSpy).toHaveBeenCalledTimes(1);
    const sentPrompt = promptSpy.mock.calls[0][0] as string;
    expect(sentPrompt).toContain('prod');
    expect(sentPrompt).toContain('api-availability');
  });
});
