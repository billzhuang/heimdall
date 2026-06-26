import { describe, it, expect } from 'vitest';
import { SUBAGENT_DESCRIPTIONS, SUBAGENT_INSTRUCTIONS, buildInstructions } from '../instructions.ts';
import { DEFAULT_MODEL } from '../model.ts';


describe('buildInstructions', () => {
  it('describes the agent, its tools, the read-only policy, and the response format', () => {
    const out = buildInstructions();
    expect(out).toMatch(/You are Heimdall/);
    expect(out).toMatch(/`kubectl`/);
    expect(out).toMatch(/`list_contexts`/);
    expect(out).toMatch(/`list_namespaces`/);
    expect(out).toMatch(/READ-ONLY/);
    expect(out).toMatch(/Thinking Summary:/);
    expect(out).toMatch(/Answer:/);
    for (const name of Object.keys(SUBAGENT_INSTRUCTIONS)) {
      expect(out).toContain(name);
    }
  });

  it('always uses dynamic discovery guidance (no pinned context or namespace)', () => {
    const out = buildInstructions();
    expect(out).toMatch(/No context is pinned/);
    expect(out).toMatch(/No namespace is pinned/);
  });

  it('omits list_contexts references when listContexts is disabled', () => {
    const out = buildInstructions(new Set(['kubectl', 'listNamespaces']));
    expect(out).not.toMatch(/`list_contexts`/);
    expect(out).not.toMatch(/No context is pinned/);
    expect(out).toMatch(/`list_namespaces`/);
    expect(out).toMatch(/No namespace is pinned/);
    expect(out).toMatch(/`kubectl`/);
  });

  it('omits list_namespaces references when listNamespaces is disabled', () => {
    const out = buildInstructions(new Set(['kubectl', 'listContexts']));
    expect(out).not.toMatch(/`list_namespaces`/);
    expect(out).not.toMatch(/No namespace is pinned/);
    expect(out).toMatch(/`list_contexts`/);
    expect(out).toMatch(/No context is pinned/);
    expect(out).toMatch(/`kubectl`/);
  });

  it('omits the Connection section entirely when both discovery tools are disabled', () => {
    const out = buildInstructions(new Set(['kubectl']));
    expect(out).not.toMatch(/## Connection/);
    expect(out).not.toMatch(/`list_contexts`/);
    expect(out).not.toMatch(/`list_namespaces`/);
    expect(out).toMatch(/`kubectl`/);
  });

  it('treats no enabledTools argument as all-enabled (backwards compatibility)', () => {
    const allEnabled = buildInstructions();
    const explicit = buildInstructions(new Set(['kubectl', 'listContexts', 'listNamespaces', 'helmRelease', 'prometheusQuery', 'awsCli', 'trivyScan', 'kubecostQuery', 'lokiQuery', 'jaegerQuery', 'datadogQuery', 'newRelicQuery', 'cdkQuery']));
    expect(allEnabled).toBe(explicit);
  });

  it('includes helm_release tool description when helmRelease is enabled', () => {
    const out = buildInstructions(new Set(['kubectl', 'listContexts', 'listNamespaces', 'helmRelease']));
    expect(out).toMatch(/`helm_release`/);
  });

  it('omits helm_release when helmRelease is disabled', () => {
    const out = buildInstructions(new Set(['kubectl', 'listContexts', 'listNamespaces']));
    expect(out).not.toMatch(/`helm_release`/);
  });

  it('includes prometheus_query tool description when prometheusQuery is enabled', () => {
    const out = buildInstructions(new Set(['kubectl', 'listContexts', 'listNamespaces', 'helmRelease', 'prometheusQuery']));
    expect(out).toMatch(/`prometheus_query`/);
  });

  it('omits prometheus_query when prometheusQuery is disabled', () => {
    const out = buildInstructions(new Set(['kubectl', 'listContexts', 'listNamespaces', 'helmRelease']));
    expect(out).not.toMatch(/`prometheus_query`/);
  });
});

describe('SUBAGENT_INSTRUCTIONS', () => {
  it('defines all specialist subagents', () => {
    expect(Object.keys(SUBAGENT_INSTRUCTIONS).sort()).toEqual([
      'aws-resource-analyzer',
      'capi-investigator',
      'cdk-investigator',
      'certificate-inspector',
      'cost-analyzer',
      'crashloop-analyzer',
      'datadog-investigator',
      'deployment-analyzer',
      'eks-troubleshooter',
      'gitops-investigator',
      'golden-signals-investigator',
      'iam-auditor',
      'kyverno-auditor',
      'log-analyzer',
      'multi-cluster-investigator',
      'netpol-auditor',
      'network-debugger',
      'newrelic-investigator',
      'oomkill-analyzer',
      'resilience-advisor',
      'resource-analyzer',
      'security-auditor',
      'slo-evaluator',
      'triage',
    ]);
  });

  it('reiterates the read-only policy in every subagent prompt', () => {
    for (const text of Object.values(SUBAGENT_INSTRUCTIONS)) {
      expect(text).toMatch(/read-only/i);
      expect(text).toMatch(/Thinking Summary/);
    }
  });
});

describe('buildInstructions — namespace lockdown', () => {
  it('includes lockdown notice when lockedNamespace is set', () => {
    const out = buildInstructions(undefined, 'prod-payments');
    expect(out).toMatch(/NAMESPACE LOCKDOWN/);
    expect(out).toContain("'prod-payments'");
  });

  it('suppresses "No namespace is pinned" when lockedNamespace is set', () => {
    const out = buildInstructions(undefined, 'prod');
    expect(out).not.toMatch(/No namespace is pinned/);
  });

  it('does not include lockdown notice when lockedNamespace is absent', () => {
    const out = buildInstructions();
    expect(out).not.toMatch(/NAMESPACE LOCKDOWN/);
    expect(out).toMatch(/No namespace is pinned/);
  });

  it('lockdown notice appears even when listContexts and listNamespaces are disabled', () => {
    const out = buildInstructions(new Set(['kubectl']), 'staging');
    expect(out).toMatch(/NAMESPACE LOCKDOWN/);
    expect(out).toContain("'staging'");
    // Connection section still appears because lockdown line is present
    expect(out).toMatch(/## Connection/);
  });
});

describe('buildInstructions — runbook context', () => {
  it('injects runbook content under a Runbook context section', () => {
    const out = buildInstructions(undefined, null, 'Follow this playbook: check HPA first.');
    expect(out).toContain('## Runbook context');
    expect(out).toContain('check HPA first');
  });

  it('does not include the Runbook context section when runbookContent is empty', () => {
    expect(buildInstructions(undefined, null, '')).not.toContain('## Runbook context');
    expect(buildInstructions()).not.toContain('## Runbook context');
  });

  it('places runbook context before the Tools section', () => {
    const out = buildInstructions(undefined, null, 'step: restart HPA');
    const rbPos = out.indexOf('## Runbook context');
    const toolsPos = out.indexOf('## Tools');
    expect(rbPos).toBeGreaterThan(-1);
    expect(rbPos).toBeLessThan(toolsPos);
  });
});

describe('netpol-auditor subagent', () => {
  it('is listed in the specialist subagents section of buildInstructions', () => {
    const out = buildInstructions();
    expect(out).toContain('netpol-auditor');
  });

  it('instructions cover uncovered-pod detection and NetworkPolicy cross-referencing', () => {
    const inst = SUBAGENT_INSTRUCTIONS['netpol-auditor'];
    expect(inst).toMatch(/networkpolicy/i);
    expect(inst).toMatch(/uncovered/i);
    expect(inst).toMatch(/podSelector/i);
  });

  it('instructions include the key kubectl commands', () => {
    const inst = SUBAGENT_INSTRUCTIONS['netpol-auditor'];
    expect(inst).toContain('kubectl get networkpolicy');
    expect(inst).toContain('kubectl get pods');
  });

  it('instructions mention ingress and egress coverage separately', () => {
    const inst = SUBAGENT_INSTRUCTIONS['netpol-auditor'];
    expect(inst).toMatch(/ingress/i);
    expect(inst).toMatch(/egress/i);
  });

  it('instructions suggest NetworkPolicy templates for uncovered workloads', () => {
    const inst = SUBAGENT_INSTRUCTIONS['netpol-auditor'];
    expect(inst).toMatch(/template/i);
    expect(inst).toMatch(/deny-all/i);
  });
});

describe('gitops-investigator subagent', () => {
  it('is listed in the specialist subagents section of buildInstructions', () => {
    const out = buildInstructions();
    expect(out).toContain('gitops-investigator');
  });

  it('instructions cover both ArgoCD and FluxCD', () => {
    const inst = SUBAGENT_INSTRUCTIONS['gitops-investigator'];
    expect(inst).toMatch(/ArgoCD/i);
    expect(inst).toMatch(/FluxCD/i);
  });

  it('instructions reference the ArgoCD Application CRD', () => {
    const inst = SUBAGENT_INSTRUCTIONS['gitops-investigator'];
    expect(inst).toContain('applications.argoproj.io');
  });

  it('instructions reference the FluxCD Kustomization and HelmRelease CRDs', () => {
    const inst = SUBAGENT_INSTRUCTIONS['gitops-investigator'];
    expect(inst).toContain('kustomizations.kustomize.toolkit.fluxcd.io');
    expect(inst).toContain('helmreleases.helm.toolkit.fluxcd.io');
  });

  it('instructions include sync status and health fields to inspect', () => {
    const inst = SUBAGENT_INSTRUCTIONS['gitops-investigator'];
    expect(inst).toMatch(/sync/i);
    expect(inst).toMatch(/health/i);
    expect(inst).toMatch(/OutOfSync|Synced/);
  });

  it('instructions mention source repository checks', () => {
    const inst = SUBAGENT_INSTRUCTIONS['gitops-investigator'];
    expect(inst).toContain('gitrepositories.source.toolkit.fluxcd.io');
  });

  it('rereads the read-only policy', () => {
    const inst = SUBAGENT_INSTRUCTIONS['gitops-investigator'];
    expect(inst).toMatch(/read-only/i);
    expect(inst).toMatch(/Thinking Summary/);
  });
});

describe('multi-cluster-investigator subagent', () => {
  it('is listed in the specialist subagents section of buildInstructions', () => {
    const out = buildInstructions();
    expect(out).toContain('multi-cluster-investigator');
  });

  it('instructions describe cross-cluster investigation workflow', () => {
    const inst = SUBAGENT_INSTRUCTIONS['multi-cluster-investigator'];
    expect(inst).toMatch(/list_contexts/i);
    expect(inst).toMatch(/context/i);
    expect(inst).toMatch(/cross-cluster/i);
  });

  it('instructions cover shared service mesh correlation', () => {
    const inst = SUBAGENT_INSTRUCTIONS['multi-cluster-investigator'];
    expect(inst).toMatch(/service.?mesh|Istio|Linkerd/i);
  });

  it('instructions cover cross-cluster DNS', () => {
    const inst = SUBAGENT_INSTRUCTIONS['multi-cluster-investigator'];
    expect(inst).toMatch(/DNS/i);
    expect(inst).toMatch(/CoreDNS/i);
  });

  it('instructions cover hub/spoke topology', () => {
    const inst = SUBAGENT_INSTRUCTIONS['multi-cluster-investigator'];
    expect(inst).toMatch(/hub.*spoke|spoke.*hub/i);
  });

  it('instructions include a per-cluster and cross-cluster reporting format', () => {
    const inst = SUBAGENT_INSTRUCTIONS['multi-cluster-investigator'];
    expect(inst).toMatch(/Per-cluster/i);
    expect(inst).toMatch(/Cross-cluster/i);
  });

  it('rereads the read-only policy', () => {
    const inst = SUBAGENT_INSTRUCTIONS['multi-cluster-investigator'];
    expect(inst).toMatch(/read-only/i);
    expect(inst).toMatch(/Thinking Summary/);
  });
});

describe('kyverno-auditor subagent', () => {
  it('is listed in the specialist subagents section of buildInstructions', () => {
    const out = buildInstructions();
    expect(out).toContain('kyverno-auditor');
  });

  it('instructions cover listing policies and reading policy reports', () => {
    const inst = SUBAGENT_INSTRUCTIONS['kyverno-auditor'];
    expect(inst).toMatch(/clusterpolicy/i);
    expect(inst).toMatch(/policyreport/i);
    expect(inst).toMatch(/clusterpolicyreport/i);
  });

  it('instructions include workflow steps to cross-reference failing pods', () => {
    const inst = SUBAGENT_INSTRUCTIONS['kyverno-auditor'];
    expect(inst).toMatch(/cross-reference/i);
    expect(inst).toMatch(/fail/i);
  });

  it('instructions include the key kubectl commands', () => {
    const inst = SUBAGENT_INSTRUCTIONS['kyverno-auditor'];
    expect(inst).toContain('kubectl get clusterpolicy');
    expect(inst).toContain('kubectl get policyreport');
    expect(inst).toContain('kubectl get clusterpolicyreport');
  });

  it('instructions describe how to summarise compliance posture', () => {
    const inst = SUBAGENT_INSTRUCTIONS['kyverno-auditor'];
    expect(inst).toMatch(/compliance posture/i);
    expect(inst).toMatch(/violation/i);
  });

  it('rereads the read-only policy', () => {
    const inst = SUBAGENT_INSTRUCTIONS['kyverno-auditor'];
    expect(inst).toMatch(/read-only/i);
    expect(inst).toMatch(/Thinking Summary/);
  });
});

describe('golden-signals-investigator subagent', () => {
  it('appears in buildInstructions when prometheusQuery is enabled', () => {
    const out = buildInstructions(new Set(['kubectl', 'prometheusQuery']));
    expect(out).toContain('golden-signals-investigator');
  });

  it('appears in buildInstructions when datadogQuery is enabled', () => {
    const out = buildInstructions(new Set(['kubectl', 'datadogQuery']));
    expect(out).toContain('golden-signals-investigator');
  });

  it('appears in buildInstructions when both prometheusQuery and datadogQuery are enabled', () => {
    const out = buildInstructions(new Set(['kubectl', 'prometheusQuery', 'datadogQuery']));
    expect(out).toContain('golden-signals-investigator');
  });

  it('does not appear in buildInstructions when neither prometheusQuery nor datadogQuery is enabled', () => {
    const out = buildInstructions(new Set(['kubectl', 'listContexts', 'listNamespaces', 'helmRelease']));
    expect(out).not.toContain('golden-signals-investigator');
  });

  it('instructions include all four golden signals: latency', () => {
    const inst = SUBAGENT_INSTRUCTIONS['golden-signals-investigator'];
    expect(inst).toMatch(/latency/i);
    expect(inst).toMatch(/p50/i);
    expect(inst).toMatch(/p99/i);
  });

  it('instructions include all four golden signals: traffic/RPS', () => {
    const inst = SUBAGENT_INSTRUCTIONS['golden-signals-investigator'];
    expect(inst).toMatch(/traffic|RPS|requests per second/i);
  });

  it('instructions include all four golden signals: error rate', () => {
    const inst = SUBAGENT_INSTRUCTIONS['golden-signals-investigator'];
    expect(inst).toMatch(/error rate/i);
  });

  it('instructions include all four golden signals: saturation', () => {
    const inst = SUBAGENT_INSTRUCTIONS['golden-signals-investigator'];
    expect(inst).toMatch(/saturation/i);
    expect(inst).toMatch(/CPU/i);
    expect(inst).toMatch(/memory/i);
  });

  it('instructions mandate "unavailable" for missing data rather than omitting the row', () => {
    const inst = SUBAGENT_INSTRUCTIONS['golden-signals-investigator'];
    expect(inst).toMatch(/unavailable/i);
  });

  it('instructions cover both Prometheus and Datadog backends', () => {
    const inst = SUBAGENT_INSTRUCTIONS['golden-signals-investigator'];
    expect(inst).toMatch(/prometheus_query/i);
    expect(inst).toMatch(/datadog_query/i);
  });

  it('instructions include a structured output table', () => {
    const inst = SUBAGENT_INSTRUCTIONS['golden-signals-investigator'];
    expect(inst).toMatch(/\| Signal/);
    expect(inst).toMatch(/\| Value/);
  });

  it('rereads the read-only policy', () => {
    const inst = SUBAGENT_INSTRUCTIONS['golden-signals-investigator'];
    expect(inst).toMatch(/read-only/i);
    expect(inst).toMatch(/Thinking Summary/);
  });
});

describe('DEFAULT_MODEL', () => {
  it('is a provider/model specifier', () => {
    expect(DEFAULT_MODEL).toMatch(/.+\/.+/);
  });
});

describe('buildInstructions — past incident context (ragContext)', () => {
  it('injects past incident content under a Past incident precedents section', () => {
    const out = buildInstructions(undefined, null, undefined, 'OOMKill on payment pod at 14:32 UTC.');
    expect(out).toContain('## Past incident precedents');
    expect(out).toContain('OOMKill on payment pod');
  });

  it('does not include the section when ragContext is absent or empty', () => {
    expect(buildInstructions()).not.toContain('## Past incident precedents');
    expect(buildInstructions(undefined, null, '', '')).not.toContain('## Past incident precedents');
  });

  it('places past incident precedents before the Tools section', () => {
    const out = buildInstructions(undefined, null, undefined, 'Prior incident details');
    const ragPos = out.indexOf('## Past incident precedents');
    const toolsPos = out.indexOf('## Tools');
    expect(ragPos).toBeGreaterThan(-1);
    expect(ragPos).toBeLessThan(toolsPos);
  });
});

describe('buildInstructions — recurring anomaly baselines (baselineContext)', () => {
  it('injects baseline content under a Recurring anomaly baselines section', () => {
    const out = buildInstructions(undefined, null, undefined, undefined, undefined, 'CPU spikes every morning at 09:00 UTC.');
    expect(out).toContain('## Recurring anomaly baselines');
    expect(out).toContain('CPU spikes every morning');
  });

  it('does not include the section when baselineContext is not provided', () => {
    expect(buildInstructions()).not.toContain('## Recurring anomaly baselines');
  });

  it('places recurring anomaly baselines before the Tools section', () => {
    const out = buildInstructions(undefined, null, undefined, undefined, undefined, 'Baseline anomalies');
    const basePos = out.indexOf('## Recurring anomaly baselines');
    const toolsPos = out.indexOf('## Tools');
    expect(basePos).toBeGreaterThan(-1);
    expect(basePos).toBeLessThan(toolsPos);
  });
});

describe('buildInstructions — SLO context', () => {
  const testSlo = {
    name: 'API availability',
    metric: 'sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))',
    target: 0.999,
    window: '30d',
    budget: 0.001,
  };

  it('injects a Configured SLOs table when slos are provided', () => {
    const out = buildInstructions(undefined, null, undefined, undefined, [testSlo]);
    expect(out).toContain('## Configured SLOs');
    expect(out).toContain('API availability');
    expect(out).toContain('0.999');
    expect(out).toContain('0.001');
    expect(out).toContain('30d');
  });

  it('omits the SLO section when the slos array is empty or not provided', () => {
    expect(buildInstructions(undefined, null, undefined, undefined, [])).not.toContain('## Configured SLOs');
    expect(buildInstructions()).not.toContain('## Configured SLOs');
  });

  it('escapes pipe characters in SLO names and metrics so the Markdown table stays valid', () => {
    const pipeSlo = { name: 'A|B slo', metric: 'metric|selector', target: 0.99, window: '7d', budget: 0.01 };
    const out = buildInstructions(undefined, null, undefined, undefined, [pipeSlo]);
    expect(out).toContain('A\\|B slo');
    expect(out).toContain('metric\\|selector');
  });

  it('places the Configured SLOs section before the Tools section', () => {
    const out = buildInstructions(undefined, null, undefined, undefined, [testSlo]);
    const sloPos = out.indexOf('## Configured SLOs');
    const toolsPos = out.indexOf('## Tools');
    expect(sloPos).toBeGreaterThan(-1);
    expect(sloPos).toBeLessThan(toolsPos);
  });
});

describe('buildInstructions — conditional subagent sections', () => {
  it('includes AWS subagents (eks-troubleshooter, iam-auditor, aws-resource-analyzer) when awsCli is enabled', () => {
    const out = buildInstructions(new Set(['kubectl', 'awsCli']));
    expect(out).toContain('eks-troubleshooter');
    expect(out).toContain('iam-auditor');
    expect(out).toContain('aws-resource-analyzer');
  });

  it('omits AWS subagents when awsCli is disabled', () => {
    const out = buildInstructions(new Set(['kubectl']));
    expect(out).not.toContain('eks-troubleshooter');
    expect(out).not.toContain('iam-auditor');
    expect(out).not.toContain('aws-resource-analyzer');
  });

  it('includes cost-analyzer when kubecostQuery is enabled', () => {
    expect(buildInstructions(new Set(['kubectl', 'kubecostQuery']))).toContain('cost-analyzer');
  });

  it('omits cost-analyzer when kubecostQuery is disabled', () => {
    expect(buildInstructions(new Set(['kubectl']))).not.toContain('cost-analyzer');
  });

  it('includes newrelic-investigator when newRelicQuery is enabled', () => {
    expect(buildInstructions(new Set(['kubectl', 'newRelicQuery']))).toContain('newrelic-investigator');
  });

  it('omits newrelic-investigator when newRelicQuery is disabled', () => {
    expect(buildInstructions(new Set(['kubectl']))).not.toContain('newrelic-investigator');
  });

  it('includes cdk-investigator when cdkQuery is enabled', () => {
    expect(buildInstructions(new Set(['kubectl', 'cdkQuery']))).toContain('cdk-investigator');
  });

  it('omits cdk-investigator when cdkQuery is disabled', () => {
    expect(buildInstructions(new Set(['kubectl']))).not.toContain('cdk-investigator');
  });

  it('enables golden-signals-investigator when only newRelicQuery is enabled', () => {
    expect(buildInstructions(new Set(['kubectl', 'newRelicQuery']))).toContain('golden-signals-investigator');
  });
});

describe('buildInstructions — no cluster tools enabled', () => {
  it('shows "No cluster tools are enabled." when the enabledTools set is empty', () => {
    const out = buildInstructions(new Set());
    expect(out).toContain('No cluster tools are enabled.');
  });
});

describe('slo-evaluator subagent', () => {
  it('is listed in the specialist subagents section of buildInstructions', () => {
    expect(buildInstructions()).toContain('slo-evaluator');
  });

  it('instructions describe the burn rate formula using current_value / budget', () => {
    const inst = SUBAGENT_INSTRUCTIONS['slo-evaluator'];
    expect(inst).toMatch(/burn.?rate/i);
    expect(inst).toContain('current_value');
    expect(inst).toContain('budget');
  });

  it('instructions describe the remaining budget formula', () => {
    const inst = SUBAGENT_INSTRUCTIONS['slo-evaluator'];
    expect(inst).toContain('remaining_budget');
    expect(inst).toMatch(/max\(0/);
  });

  it('instructions require prometheus_query to evaluate each SLO metric', () => {
    expect(SUBAGENT_INSTRUCTIONS['slo-evaluator']).toMatch(/prometheus_query/);
  });

  it('instructions mandate a Healthy SLOs summary table', () => {
    const inst = SUBAGENT_INSTRUCTIONS['slo-evaluator'];
    expect(inst).toMatch(/Healthy SLOs/i);
    expect(inst).toMatch(/\| Name/);
    expect(inst).toMatch(/Burn Rate/i);
  });

  it('rereads the read-only policy', () => {
    const inst = SUBAGENT_INSTRUCTIONS['slo-evaluator'];
    expect(inst).toMatch(/read-only/i);
    expect(inst).toMatch(/Thinking Summary/);
  });
});

describe('certificate-inspector subagent', () => {
  it('is listed in the specialist subagents section of buildInstructions', () => {
    expect(buildInstructions()).toContain('certificate-inspector');
  });

  it('instructions cover cert-manager Certificate CRD detection', () => {
    expect(SUBAGENT_INSTRUCTIONS['certificate-inspector']).toContain('certificates.cert-manager.io');
  });

  it('instructions define severity tiers for certificate expiry', () => {
    const inst = SUBAGENT_INSTRUCTIONS['certificate-inspector'];
    expect(inst).toMatch(/CRITICAL/);
    expect(inst).toMatch(/Expired/i);
    expect(inst).toMatch(/7 days/);
    expect(inst).toMatch(/30 days/);
  });

  it('instructions cover Ingress TLS audit', () => {
    const inst = SUBAGENT_INSTRUCTIONS['certificate-inspector'];
    expect(inst).toMatch(/Ingress/);
    expect(inst).toMatch(/TLS/);
  });

  it('rereads the read-only policy', () => {
    const inst = SUBAGENT_INSTRUCTIONS['certificate-inspector'];
    expect(inst).toMatch(/read-only/i);
    expect(inst).toMatch(/Thinking Summary/);
  });
});

describe('SUBAGENT_DESCRIPTIONS', () => {
  it('has exactly the same keys as SUBAGENT_INSTRUCTIONS', () => {
    const descKeys = Object.keys(SUBAGENT_DESCRIPTIONS).sort();
    const instKeys = Object.keys(SUBAGENT_INSTRUCTIONS).sort();
    expect(descKeys).toEqual(instKeys);
  });

  it('every description is a non-empty string', () => {
    for (const [name, desc] of Object.entries(SUBAGENT_DESCRIPTIONS)) {
      expect(typeof desc).toBe('string');
      expect(desc.length).toBeGreaterThan(0);
      void name;
    }
  });

  it('datadog-investigator description references Datadog', () => {
    expect(SUBAGENT_DESCRIPTIONS['datadog-investigator']).toMatch(/Datadog/i);
  });

  it('golden-signals-investigator description references all four signals', () => {
    const desc = SUBAGENT_DESCRIPTIONS['golden-signals-investigator'];
    expect(desc).toMatch(/latency/i);
    expect(desc).toMatch(/error rate/i);
    expect(desc).toMatch(/saturation/i);
  });
});

describe('buildInstructions — datadog-investigator conditional', () => {
  it('includes datadog-investigator when datadogQuery is enabled', () => {
    const out = buildInstructions(new Set(['kubectl', 'datadogQuery']));
    expect(out).toContain('datadog-investigator');
  });

  it('omits datadog-investigator when datadogQuery is disabled', () => {
    const out = buildInstructions(new Set(['kubectl']));
    expect(out).not.toContain('datadog-investigator');
  });
});

describe('buildInstructions — section ordering', () => {
  it('places runbook context before past incident precedents', () => {
    const out = buildInstructions(undefined, null, 'runbook steps', 'prior incident');
    const rbPos = out.indexOf('## Runbook context');
    const ragPos = out.indexOf('## Past incident precedents');
    expect(rbPos).toBeGreaterThan(-1);
    expect(ragPos).toBeGreaterThan(-1);
    expect(rbPos).toBeLessThan(ragPos);
  });

  it('places past incident precedents before recurring anomaly baselines', () => {
    const out = buildInstructions(undefined, null, undefined, 'rag context', undefined, 'baseline anomalies');
    const ragPos = out.indexOf('## Past incident precedents');
    const basePos = out.indexOf('## Recurring anomaly baselines');
    expect(ragPos).toBeGreaterThan(-1);
    expect(basePos).toBeGreaterThan(-1);
    expect(ragPos).toBeLessThan(basePos);
  });
});

describe('buildInstructions — multiple SLOs in table', () => {
  it('includes all SLO names when two SLOs are configured', () => {
    const slos = [
      { name: 'API availability', metric: 'metric_a', target: 0.999, window: '30d', budget: 0.001 },
      { name: 'p99 latency', metric: 'metric_b', target: 0.995, window: '7d', budget: 0.005 },
    ];
    const out = buildInstructions(undefined, null, undefined, undefined, slos);
    expect(out).toContain('API availability');
    expect(out).toContain('p99 latency');
    expect(out).toContain('metric_a');
    expect(out).toContain('metric_b');
  });
});
