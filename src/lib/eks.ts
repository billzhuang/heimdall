/**
 * EKS kubeconfig generation via `aws eks update-kubeconfig`.
 * Used when HEIMDALL_EKS_CLUSTER is set and the process is not running
 * in-cluster. The generated file lives in the OS temp directory and is
 * isolated per-user to avoid cross-user conflicts on shared hosts.
 */
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const EXEC_TIMEOUT_MS = 30_000;

/** True when EKS dynamic kubeconfig generation is configured. */
export function isEksMode(): boolean {
  return !!process.env.HEIMDALL_EKS_CLUSTER;
}

/** Per-user temp path for the generated EKS kubeconfig. */
export function eksKubeconfigPath(): string {
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : undefined;
  const user = uid ?? process.env.USER ?? process.env.USERNAME ?? 'default';
  return join(tmpdir(), `heimdall-eks-kubeconfig-${user}`);
}

/**
 * Run `aws eks update-kubeconfig` for the cluster named in HEIMDALL_EKS_CLUSTER,
 * writing the result to a temp file and returning its path.
 *
 * Region is resolved from HEIMDALL_EKS_REGION → AWS_DEFAULT_REGION → AWS_REGION.
 * Throws when the AWS CLI is unavailable or the call fails.
 */
export async function generateEksKubeconfig(): Promise<string> {
  const cluster = process.env.HEIMDALL_EKS_CLUSTER;
  if (!cluster) {
    throw new Error('HEIMDALL_EKS_CLUSTER is not set');
  }

  const region =
    process.env.HEIMDALL_EKS_REGION ??
    process.env.AWS_DEFAULT_REGION ??
    process.env.AWS_REGION;

  const outPath = eksKubeconfigPath();

  const awsArgs = ['eks', 'update-kubeconfig', '--name', cluster, '--kubeconfig', outPath];
  if (region) {
    awsArgs.push('--region', region);
  }

  await execFileAsync('aws', awsArgs, { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS });
  return outPath;
}
