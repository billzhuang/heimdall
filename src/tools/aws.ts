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

export function makeAwsCli(options?: RunAwsCliOptions) {
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
      '--filter to narrow output. Requires AWS CLI credentials in the environment.',
    parameters: v.object({
      args: v.pipe(
        v.string(),
        v.description('Arguments passed to the AWS CLI, excluding the leading "aws".'),
      ),
    }),
    execute: async ({ args }) => runAwsCli(args, options),
  });
}

export const awsCli = makeAwsCli();
