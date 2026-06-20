/**
 * Tests for trivy.ts — policy decisions and input validation only.
 *
 * Real `trivy` is NOT invoked. We assert:
 *  1. runTrivy returns early for missing required params.
 *  2. runTrivy returns a BLOCKED prefix for blocked scan types before exec.
 */
import { describe, it, expect } from 'vitest';
import { runTrivy } from '../trivy.ts';
import { BLOCKED_PREFIX } from '../harness.ts';

const BLOCKED_RE = new RegExp(`^${BLOCKED_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');

describe('runTrivy — input validation (no exec)', () => {
  it('returns error when scanType is empty', async () => {
    const result = await runTrivy('', 'nginx:latest', []);
    expect(result).toMatch(/scan type and target are required/i);
  });

  it('returns error when target is empty', async () => {
    const result = await runTrivy('image', '', []);
    expect(result).toMatch(/scan type and target are required/i);
  });

  it('returns error when both scanType and target are empty', async () => {
    const result = await runTrivy('', '', []);
    expect(result).toMatch(/scan type and target are required/i);
  });
});

describe('runTrivy — blocked commands (no exec)', () => {
  it('blocks trivy server before exec', async () => {
    const result = await runTrivy('server', 'localhost:4954', []);
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks trivy plugin before exec', async () => {
    const result = await runTrivy('plugin', 'install trivy-plugin-aqua', []);
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks unknown scan types (default-deny)', async () => {
    const result = await runTrivy('kubernetes', 'cluster', []);
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks shell metacharacters in extraArgs', async () => {
    const result = await runTrivy('image', 'nginx:latest', ['--severity', 'HIGH; rm -rf /']);
    expect(result).toMatch(BLOCKED_RE);
  });
});

