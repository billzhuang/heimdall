/**
 * The `cdk_query` tool: read-only AWS CDK CLI inspection for the agent.
 *
 * Disabled by default — operators opt in by setting `tools: { cdk_query: true }`
 * in `heimdall.config.yaml`. Requires the CDK CLI (`cdk`) on PATH, AWS credentials,
 * and optionally a CDK app in the working directory (for diff/synth/metadata).
 *
 * Only informational subcommands are permitted: ls, list, synth, synthesize,
 * diff, metadata, context, notices, docs, doc, version, doctor, drift.
 * Mutating subcommands (deploy, destroy, bootstrap, watch, import, migrate, gc,
 * rollback) are blocked in code by the safety policy in cdk-safety.ts.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { runCdk, type RunCdkOptions } from '../lib/cdk.ts';
import type { CompiledRedactionRule } from '../lib/regex-redact.ts';

export function makeCdkQuery(options?: RunCdkOptions, regexRedactionRules?: CompiledRedactionRule[]) {
  return defineTool({
    name: 'cdk_query',
    description:
      'Run a single READ-ONLY CDK CLI command and return its output. ' +
      'Provide everything after the word "cdk" in `args` (for example: ' +
      '"ls", "diff MyStack", "synth", "metadata MyStack", ' +
      '"context", "notices", "diff --app \'node app.js\' MyStack"). ' +
      'Allowed subcommands: ls, list, synth, synthesize, diff, metadata, ' +
      'context, notices, docs, doc, version, doctor, drift. ' +
      'Destructive subcommands (deploy, destroy, bootstrap, watch, import, ' +
      'migrate, gc, rollback) are blocked. ' +
      'There is no shell, so pipes/redirects do not work. ' +
      'For diff/synth/metadata the CDK app must be in the working directory or ' +
      'specified via --app. Credentials are resolved by the AWS CLI credential chain.',
    parameters: v.object({
      args: v.pipe(
        v.string(),
        v.description('Arguments passed to the CDK CLI, excluding the leading "cdk".'),
      ),
    }),
    execute: async ({ args }) => runCdk(args, { ...options, regexRedactionRules }),
  });
}

export const cdkQuery = makeCdkQuery();
