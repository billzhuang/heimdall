/**
 * The `aws_cli` tool: read-only AWS CLI access for the agent.
 *
 * Disabled by default — operators opt in by setting `tools: { aws_cli: true }`
 * in `heimdall.config.yaml`. This prevents unexpected AWS credential usage on
 * clusters where AWS CLI is not configured.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { runAwsCli, type RunAwsCliOptions } from '../lib/aws.ts';
import type { CompiledRedactionRule } from '../lib/regex-redact.ts';
import type { ToolPlugin } from '../lib/plugin.ts';

export function makeAwsCli(options?: RunAwsCliOptions, regexRedactionRules?: CompiledRedactionRule[]) {
  return defineTool({
    name: 'aws_cli',
    description:
      'Run a single READ-ONLY AWS CLI command and return its output. ' +
      'Provide everything after the word "aws" in `args` (for example: ' +
      '"ec2 describe-instances --region us-east-1", "iam list-roles", or ' +
      '"eks describe-cluster --name my-cluster"). ' +
      'Only read-only subcommands are permitted (describe-*, get-*, list-*, show-*). ' +
      'Destructive subcommands (create-*, delete-*, terminate-*, put-*, update-*, ' +
      'attach-*, detach-*, modify-*, start-*, stop-*, run-instances, ...) are blocked. ' +
      'There is no shell, so pipes/redirects do not work — use --query (JMESPath) or ' +
      '--filter to narrow output. ' +
      'Credentials are resolved by the AWS CLI credential chain: static env vars ' +
      '(AWS_ACCESS_KEY_ID), IRSA / OIDC web identity (AWS_ROLE_ARN + ' +
      'AWS_WEB_IDENTITY_TOKEN_FILE), EKS Pod Identity ' +
      '(AWS_CONTAINER_CREDENTIALS_RELATIVE_URI), or instance profile.',
    parameters: v.object({
      args: v.pipe(
        v.string(),
        v.description('Arguments passed to the AWS CLI, excluding the leading "aws".'),
      ),
    }),
    execute: async ({ args }) => runAwsCli(args, { ...options, regexRedactionRules }),
  });
}

export const awsCli = makeAwsCli();

export const awsCliPlugin: ToolPlugin = {
  key: 'awsCli',
  factory: (config, rules) => makeAwsCli({ audit: config.audit }, rules),
};
