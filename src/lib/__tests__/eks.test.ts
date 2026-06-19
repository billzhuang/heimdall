import { describe, it, expect, beforeEach } from 'vitest';
import { _resetEksKubeconfigCache, eksKubeconfigPath, ensureEksKubeconfig, generateEksKubeconfig, isEksMode } from '../eks.ts';

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

describe('ensureEksKubeconfig', () => {
  beforeEach(() => _resetEksKubeconfigCache());

  it('throws when HEIMDALL_EKS_CLUSTER is not set', async () => {
    const prev = process.env.HEIMDALL_EKS_CLUSTER;
    try {
      delete process.env.HEIMDALL_EKS_CLUSTER;
      await expect(ensureEksKubeconfig()).rejects.toThrow('HEIMDALL_EKS_CLUSTER is not set');
    } finally {
      if (prev !== undefined) process.env.HEIMDALL_EKS_CLUSTER = prev;
    }
  });

  it('returns the same promise on repeated calls (caches the generation)', async () => {
    const prev = process.env.HEIMDALL_EKS_CLUSTER;
    try {
      process.env.HEIMDALL_EKS_CLUSTER = 'my-cluster';
      const p1 = ensureEksKubeconfig();
      const p2 = ensureEksKubeconfig();
      expect(p1).toBe(p2);
      // Consume the rejection so it doesn't become an unhandled rejection.
      // (The `aws` binary is not available in the test environment.)
      await p1.catch(() => {});
    } finally {
      if (prev === undefined) delete process.env.HEIMDALL_EKS_CLUSTER;
      else process.env.HEIMDALL_EKS_CLUSTER = prev;
      _resetEksKubeconfigCache();
    }
  });
});
