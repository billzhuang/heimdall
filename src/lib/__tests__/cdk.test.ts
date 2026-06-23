/**
 * Tests for cdk.ts — tokenization and policy decisions only.
 *
 * Real `cdk` CLI is NOT invoked. We assert:
 *  1. tokenizeCdkArgs handles quoting, escaping, and strips the leading "cdk" token.
 *  2. runCdk returns before exec for blocked commands and empty inputs.
 */
import { describe, it, expect } from 'vitest';
import { tokenizeCdkArgs, runCdk } from '../cdk.ts';
import { BLOCKED_RE } from './test-helpers.ts';

describe('tokenizeCdkArgs', () => {
  it('strips a leading cdk token (lowercase)', () => {
    expect(tokenizeCdkArgs('cdk ls')).toEqual(['ls']);
  });

  it('strips a leading CDK token (uppercase)', () => {
    expect(tokenizeCdkArgs('CDK diff MyStack')).toEqual(['diff', 'MyStack']);
  });

  it('keeps tokens when no leading cdk is present', () => {
    expect(tokenizeCdkArgs('ls')).toEqual(['ls']);
  });

  it('handles single-quoted arguments', () => {
    expect(tokenizeCdkArgs("diff --app 'node app.js' MyStack")).toEqual([
      'diff',
      '--app',
      'node app.js',
      'MyStack',
    ]);
  });

  it('handles double-quoted arguments', () => {
    expect(tokenizeCdkArgs('diff --app "node app.js" MyStack')).toEqual([
      'diff',
      '--app',
      'node app.js',
      'MyStack',
    ]);
  });

  it('handles escaped characters inside double quotes', () => {
    expect(tokenizeCdkArgs('synth --app "node \\\"app.js\\\""')).toEqual([
      'synth',
      '--app',
      'node "app.js"',
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(tokenizeCdkArgs('')).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(tokenizeCdkArgs('   ')).toEqual([]);
  });

  it('handles multiple spaces between tokens', () => {
    expect(tokenizeCdkArgs('cdk   diff   MyStack')).toEqual(['diff', 'MyStack']);
  });

  it('handles --profile flag', () => {
    expect(tokenizeCdkArgs('cdk --profile prod diff MyStack')).toEqual([
      '--profile',
      'prod',
      'diff',
      'MyStack',
    ]);
  });
});

describe('runCdk — input validation (no exec)', () => {
  it('returns error for empty args', async () => {
    const result = await runCdk('');
    expect(result).toMatch(/no CDK CLI arguments provided/i);
  });

  it('returns error for whitespace-only args', async () => {
    const result = await runCdk('   ');
    expect(result).toMatch(/no CDK CLI arguments provided/i);
  });

  it('blocks deploy before exec (BLOCKED_PREFIX)', async () => {
    const result = await runCdk('deploy');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks cdk deploy MyStack before exec', async () => {
    const result = await runCdk('cdk deploy MyStack');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks destroy before exec', async () => {
    const result = await runCdk('destroy MyStack');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks bootstrap before exec', async () => {
    const result = await runCdk('bootstrap');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks watch before exec', async () => {
    const result = await runCdk('watch MyStack');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks gc before exec', async () => {
    const result = await runCdk('gc');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks rollback before exec', async () => {
    const result = await runCdk('rollback MyStack');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks unknown subcommands (default-deny)', async () => {
    const result = await runCdk('exec-this-strange-command');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks unknown subcommand derived from a non-CDK string', async () => {
    // runCdk prepends "cdk " to inputs not already starting with "cdk",
    // so "kubectl get pods" → "cdk kubectl get pods" → unknown subcommand "kubectl" → blocked.
    const result = await runCdk('kubectl get pods');
    expect(result).toMatch(BLOCKED_RE);
  });

  it('blocks destructive command even when preceded by global flags', async () => {
    const result = await runCdk('--profile prod deploy MyStack');
    expect(result).toMatch(BLOCKED_RE);
  });
});
