import { describe, it, expect, vi, beforeEach } from 'vitest';

const { runTrivy } = vi.hoisted(() => ({ runTrivy: vi.fn() }));
vi.mock('../../lib/trivy.ts', () => ({
  runTrivy,
  NO_OUTPUT_MESSAGE: '(trivy produced no output)',
}));

import { makeTrivyScan, trivyScan } from '../trivy.ts';

beforeEach(() => runTrivy.mockReset());

describe('makeTrivyScan', () => {
  it('tool name is trivy_scan', () => {
    expect(makeTrivyScan().name).toBe('trivy_scan');
  });

  it('singleton export has correct name', () => {
    expect(trivyScan.name).toBe('trivy_scan');
  });

  it('runs an image scan with no extra args by default', async () => {
    runTrivy.mockResolvedValue('0 vulnerabilities');
    const tool = makeTrivyScan();
    const result = await tool.execute({ scanType: 'image', target: 'nginx:1.25' });
    expect(result).toBe('0 vulnerabilities');
    expect(runTrivy).toHaveBeenCalledWith('image', 'nginx:1.25', [], expect.anything());
  });

  it('adds --severity flag when severity is provided', async () => {
    runTrivy.mockResolvedValue('2 HIGH vulns');
    const tool = makeTrivyScan();
    await tool.execute({ scanType: 'image', target: 'nginx:1.25', severity: 'CRITICAL,HIGH' });
    expect(runTrivy).toHaveBeenCalledWith(
      'image',
      'nginx:1.25',
      expect.arrayContaining(['--severity', 'CRITICAL,HIGH']),
      expect.anything(),
    );
  });

  it('adds --format flag when format is provided', async () => {
    runTrivy.mockResolvedValue('{}');
    const tool = makeTrivyScan();
    await tool.execute({ scanType: 'image', target: 'nginx:1.25', format: 'json' });
    expect(runTrivy).toHaveBeenCalledWith(
      'image',
      'nginx:1.25',
      expect.arrayContaining(['--format', 'json']),
      expect.anything(),
    );
  });

  it('adds --ignore-unfixed flag when ignoreUnfixed is true', async () => {
    runTrivy.mockResolvedValue('fixed only');
    const tool = makeTrivyScan();
    await tool.execute({ scanType: 'image', target: 'nginx:1.25', ignoreUnfixed: true });
    expect(runTrivy).toHaveBeenCalledWith(
      'image',
      'nginx:1.25',
      expect.arrayContaining(['--ignore-unfixed']),
      expect.anything(),
    );
  });

  it('adds --scanners flag for fs scans to disable secret scanning', async () => {
    runTrivy.mockResolvedValue('ok');
    const tool = makeTrivyScan();
    await tool.execute({ scanType: 'fs', target: '/app' });
    expect(runTrivy).toHaveBeenCalledWith(
      'fs',
      '/app',
      expect.arrayContaining(['--scanners', 'vuln,misconfig']),
      expect.anything(),
    );
  });

  it('does NOT add --scanners flag for non-fs scans', async () => {
    runTrivy.mockResolvedValue('ok');
    const tool = makeTrivyScan();
    await tool.execute({ scanType: 'image', target: 'myimage:latest' });
    const extraArgs = runTrivy.mock.calls[0][2] as string[];
    expect(extraArgs).not.toContain('vuln,misconfig');
  });

  it('accumulates multiple extra flags when provided together', async () => {
    runTrivy.mockResolvedValue('ok');
    const tool = makeTrivyScan();
    await tool.execute({
      scanType: 'image',
      target: 'myimage:latest',
      severity: 'CRITICAL',
      format: 'sarif',
      ignoreUnfixed: true,
    });
    const extraArgs = runTrivy.mock.calls[0][2] as string[];
    expect(extraArgs).toContain('--severity');
    expect(extraArgs).toContain('CRITICAL');
    expect(extraArgs).toContain('--format');
    expect(extraArgs).toContain('sarif');
    expect(extraArgs).toContain('--ignore-unfixed');
  });

  it('passes blocked result straight through', async () => {
    runTrivy.mockResolvedValue('BLOCKED: Destructive scan type detected');
    const tool = makeTrivyScan();
    const result = await tool.execute({ scanType: 'image', target: 'dangerous:image' });
    expect(result).toMatch(/^BLOCKED:/);
  });
});
