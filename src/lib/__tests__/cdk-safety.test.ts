import { describe, it, expect } from 'vitest';
import {
  ALLOWED_CDK_COMMANDS,
  DESTRUCTIVE_CDK_COMMANDS,
  parseCdkCommand,
  tokenizeCdkCommand,
  validateCdkCommand,
} from '../cdk-safety.ts';

describe('parseCdkCommand', () => {
  it('detects non-CDK commands', () => {
    const result = parseCdkCommand('kubectl get pods');
    expect(result.isCdk).toBe(false);
    expect(result.subcommand).toBeNull();
  });

  it('parses a bare cdk command', () => {
    const result = parseCdkCommand('cdk');
    expect(result.isCdk).toBe(true);
    expect(result.subcommand).toBeNull();
  });

  it('parses a simple ls command', () => {
    const result = parseCdkCommand('cdk ls');
    expect(result.isCdk).toBe(true);
    expect(result.subcommand).toBe('ls');
  });

  it('parses diff with stack name arg', () => {
    const result = parseCdkCommand('cdk diff MyStack');
    expect(result.isCdk).toBe(true);
    expect(result.subcommand).toBe('diff');
    expect(result.args).toContain('MyStack');
  });

  it('parses a command with global --app flag (space form)', () => {
    const result = parseCdkCommand('cdk --app "node app.js" diff MyStack');
    expect(result.isCdk).toBe(true);
    expect(result.subcommand).toBe('diff');
  });

  it('parses command with --context/-c flag', () => {
    const result = parseCdkCommand('cdk --context env=prod ls');
    expect(result.isCdk).toBe(true);
    expect(result.subcommand).toBe('ls');
  });

  it('parses synth with stack selector', () => {
    const result = parseCdkCommand('cdk synth InfraStack --output ./out');
    expect(result.isCdk).toBe(true);
    expect(result.subcommand).toBe('synth');
  });

  it('does not let a value-taking flag hide a destructive subcommand', () => {
    const result = parseCdkCommand('cdk --app "node app.js" deploy MyStack');
    expect(result.isCdk).toBe(true);
    expect(result.subcommand).toBe('deploy');
  });

  it('lowercases the subcommand', () => {
    const result = parseCdkCommand('cdk LS');
    expect(result.subcommand).toBe('ls');
  });
});

describe('validateCdkCommand', () => {
  it('returns null for non-CDK commands', () => {
    expect(validateCdkCommand('kubectl get pods')).toBeNull();
    expect(validateCdkCommand('helm list')).toBeNull();
    expect(validateCdkCommand('')).toBeNull();
    expect(validateCdkCommand('aws ec2 describe-instances')).toBeNull();
  });

  it('allows all read-only subcommands', () => {
    const cases = [
      'cdk ls',
      'cdk list',
      'cdk synth',
      'cdk synthesize',
      'cdk diff MyStack',
      'cdk metadata MyStack',
      'cdk context',
      'cdk notices',
      'cdk docs',
      'cdk doc',
      'cdk version',
      'cdk doctor',
      'cdk drift MyStack',
    ];
    for (const cmd of cases) {
      const result = validateCdkCommand(cmd);
      expect(result, `expected ${cmd} to be allowed`).not.toBeNull();
      expect(result?.allowed, `expected ${cmd} allowed=true`).toBe(true);
    }
  });

  it('blocks all documented destructive subcommands', () => {
    const cases = [
      'cdk deploy',
      'cdk deploy MyStack',
      'cdk destroy MyStack',
      'cdk bootstrap',
      'cdk watch MyStack',
      'cdk import MyStack',
      'cdk migrate',
      'cdk gc',
      'cdk rollback MyStack',
      'cdk acknowledge 12345',
      'cdk ack 12345',
    ];
    for (const cmd of cases) {
      const result = validateCdkCommand(cmd);
      expect(result, `expected ${cmd} to be blocked`).not.toBeNull();
      expect(result?.allowed, `expected ${cmd} allowed=false`).toBe(false);
      expect(result?.reason).toMatch(/blocked/i);
    }
  });

  it('blocks unknown subcommands by default (default-deny)', () => {
    const cases = [
      'cdk unknown-subcommand',
      'cdk hack',
      'cdk exec',
    ];
    for (const cmd of cases) {
      const result = validateCdkCommand(cmd);
      expect(result).not.toBeNull();
      expect(result?.allowed).toBe(false);
    }
  });

  it('allows bare cdk (help output, harmless)', () => {
    expect(validateCdkCommand('cdk')?.allowed).toBe(true);
  });

  it('blocks destructive commands even with global flags preceding them', () => {
    const result = validateCdkCommand('cdk --app "node app.js" --profile prod deploy MyStack');
    expect(result?.allowed).toBe(false);
  });

  it('allows read-only commands with global flags preceding them', () => {
    const result = validateCdkCommand('cdk --app "node app.js" --profile prod diff MyStack');
    expect(result?.allowed).toBe(true);
  });

  it('does not let boolean flags hide a destructive subcommand', () => {
    const result = validateCdkCommand('cdk --no-color deploy MyStack');
    expect(result?.allowed).toBe(false);
  });

  it('correctly parses read-only commands following boolean flags', () => {
    const result = validateCdkCommand('cdk --no-color ls');
    expect(result?.allowed).toBe(true);
  });
});

describe('tokenizeCdkCommand — backslash escape outside quotes', () => {
  it('treats a backslash-escaped space as part of the current token', () => {
    expect(tokenizeCdkCommand('foo\\ bar')).toEqual(['foo bar']);
  });
});

describe('DESTRUCTIVE_CDK_COMMANDS and ALLOWED_CDK_COMMANDS constants', () => {
  it('DESTRUCTIVE_CDK_COMMANDS contains expected destructive verbs', () => {
    expect(DESTRUCTIVE_CDK_COMMANDS).toContain('deploy');
    expect(DESTRUCTIVE_CDK_COMMANDS).toContain('destroy');
    expect(DESTRUCTIVE_CDK_COMMANDS).toContain('bootstrap');
    expect(DESTRUCTIVE_CDK_COMMANDS).toContain('watch');
    expect(DESTRUCTIVE_CDK_COMMANDS).toContain('gc');
    expect(DESTRUCTIVE_CDK_COMMANDS).toContain('rollback');
  });

  it('ALLOWED_CDK_COMMANDS contains expected read-only verbs', () => {
    expect(ALLOWED_CDK_COMMANDS).toContain('ls');
    expect(ALLOWED_CDK_COMMANDS).toContain('list');
    expect(ALLOWED_CDK_COMMANDS).toContain('diff');
    expect(ALLOWED_CDK_COMMANDS).toContain('synth');
    expect(ALLOWED_CDK_COMMANDS).toContain('metadata');
    expect(ALLOWED_CDK_COMMANDS).toContain('context');
    expect(ALLOWED_CDK_COMMANDS).toContain('drift');
  });
});
