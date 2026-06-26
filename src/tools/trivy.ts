/**
 * The `trivy_scan` tool: read-only container image and IaC vulnerability scanning.
 *
 * Disabled by default — operators opt in by setting `tools: { trivyScan: true }`
 * in `heimdall.config.yaml`. This prevents unexpected network traffic (Trivy DB
 * pulls) on clusters where a Trivy binary is not available.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { runTrivy, type RunTrivyOptions } from '../lib/trivy.ts';
import type { CompiledRedactionRule } from '../lib/regex-redact.ts';
import type { ToolPlugin } from '../lib/plugin.ts';

export function makeTrivyScan(options?: RunTrivyOptions, regexRedactionRules?: CompiledRedactionRule[]) {
  return defineTool({
    name: 'trivy_scan',
    description:
      'Scan a container image or IaC configuration for known CVEs and misconfigurations ' +
      'using Trivy. Runs trivy in read-only mode — no cluster state is changed. ' +
      'Scan types: "image" (container image — most common), "fs" (local filesystem/directory), ' +
      '"config" (IaC files: Kubernetes YAML, Terraform, Helm charts), ' +
      '"sbom" (Software Bill of Materials from a pre-generated SBOM file). ' +
      'Use severity to focus results (e.g. "CRITICAL,HIGH"). ' +
      'Requires the trivy binary to be available on PATH. ' +
      'Typical workflow: kubectl get pods -o json → extract image refs → trivy_scan each image.',
    input: v.object({
      scanType: v.pipe(
        v.picklist(['image', 'fs', 'config', 'sbom']),
        v.description('Trivy scan type: "image" for container images, "fs" for filesystem, "config" for IaC, "sbom" for SBOM files.'),
      ),
      target: v.pipe(
        v.string(),
        v.description(
          'Scan target. For "image": a full image ref (e.g. "nginx:1.25", "gcr.io/project/app:v1.0@sha256:..."). ' +
          'For "fs"/"config": a filesystem path. For "sbom": path to the SBOM file.',
        ),
      ),
      severity: v.pipe(
        v.nullish(v.string()),
        v.description(
          'Comma-separated severity filter, e.g. "CRITICAL,HIGH". ' +
          'Omit to return all severities. Reduces output size on large images.',
        ),
      ),
      format: v.pipe(
        v.nullish(v.picklist(['table', 'json', 'sarif', 'cyclonedx'])),
        v.description('Output format. Defaults to "table" for human-readable output. Use "json" for structured parsing.'),
      ),
      ignoreUnfixed: v.pipe(
        v.nullish(v.boolean()),
        v.description('When true, omit vulnerabilities that have no available fix. Reduces noise for triage.'),
      ),
    }),
    run: async ({ input: { scanType, target, severity, format, ignoreUnfixed } }) => {
      const extraArgs: string[] = [];
      if (severity) extraArgs.push('--severity', severity);
      if (format) extraArgs.push('--format', format);
      if (ignoreUnfixed) extraArgs.push('--ignore-unfixed');
      // For filesystem scans, disable secret scanning to prevent leaking host
      // credentials or mounted K8s secrets from the runtime container.
      if (scanType === 'fs') extraArgs.push('--scanners', 'vuln,misconfig');
      return runTrivy(scanType, target, extraArgs, {
        ...options,
        regexRedactionRules: regexRedactionRules ?? options?.regexRedactionRules,
      });
    },
  });
}

export const trivyScan = makeTrivyScan();

export const trivyScanPlugin: ToolPlugin = {
  key: 'trivyScan',
  factory: (config, rules) => makeTrivyScan({ audit: config.audit }, rules),
};
