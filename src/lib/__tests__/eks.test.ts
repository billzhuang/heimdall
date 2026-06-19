import { describe, it, expect } from 'vitest';
import { eksKubeconfigPath, generateEksKubeconfig, isEksMode } from '../eks.ts';

describe('isEksMode', () => {
  it('returns true when HEIMDALL_EKS_CLUSTER is set', () => {
    const prev = process.env.HEIMDALL_EKS_CLUSTER;
    try {
      process.env.HEIMDALL_EKS_CLUSTER = 'my-cluster';
      expect(isEksMode()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.HEIMDALL_EKS_CLUSTER;
      else process.env.HEIMDALL_EKS_CLUSTER = prev;
    }
  });

  it('returns false when HEIMDALL_EKS_CLUSTER is absent', () => {
    const prev = process.env.HEIMDALL_EKS_CLUSTER;
    try {
      delete process.env.HEIMDALL_EKS_CLUSTER;
      expect(isEksMode()).toBe(false);
    } finally {
      if (prev !== undefined) process.env.HEIMDALL_EKS_CLUSTER = prev;
    }
  });
});

describe('eksKubeconfigPath', () => {
  it('returns a stable temp-dir path containing "heimdall-eks-kubeconfig"', () => {
    const p = eksKubeconfigPath();
    expect(p).toMatch(/heimdall-eks-kubeconfig/);
  });
});

describe('generateEksKubeconfig', () => {
  it('throws when HEIMDALL_EKS_CLUSTER is not set', async () => {
    const prev = process.env.HEIMDALL_EKS_CLUSTER;
    try {
      delete process.env.HEIMDALL_EKS_CLUSTER;
      await expect(generateEksKubeconfig()).rejects.toThrow('HEIMDALL_EKS_CLUSTER is not set');
    } finally {
      if (prev !== undefined) process.env.HEIMDALL_EKS_CLUSTER = prev;
    }
  });
});
