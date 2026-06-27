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

  it('parses a path-based cdk binary', () => {
    const result = parseCdkCommand('/usr/local/bin/cdk diff MyStack');
    expect(result.isCdk).toBe(true);
    expect(result.subcommand).toBe('diff');
    expect(result.args).toEqual(['MyStack']);
  });

  it('handles -c short form (value-consuming, space form)', () => {
    const result = parseCdkCommand('cdk -c env=prod ls');
    expect(result.isCdk).toBe(true);
    expect(result.subcommand).toBe('ls');
  });

  it('does not consume next token for --key=value equals form', () => {
    const result = parseCdkCommand('cdk --context=env=prod ls');
    expect(result.isCdk).toBe(true);
    expect(result.subcommand).toBe('ls');
  });

  it('captures multiple args after subcommand', () => {
    const result = parseCdkCommand('cdk diff Stack1 Stack2 --exclusively');
    expect(result.subcommand).toBe('diff');
    expect(result.args).toEqual(['Stack1', 'Stack2', '--exclusively']);
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

  it('blocks destructive commands invoked via a path-based binary', () => {
    const result = validateCdkCommand('/usr/local/bin/cdk deploy MyStack');
    expect(result?.allowed).toBe(false);
    expect(result?.reason).toMatch(/blocked/i);
  });

  it('allows read-only commands via a path-based binary', () => {
    const result = validateCdkCommand('/usr/local/bin/cdk diff MyStack');
    expect(result?.allowed).toBe(true);
  });

  it('blocks destructive command after --key=value equals-form flag', () => {
    const result = validateCdkCommand('cdk --output=./cdk.out deploy MyStack');
    expect(result?.allowed).toBe(false);
  });

  it('allows read-only command after --key=value equals-form flag', () => {
    const result = validateCdkCommand('cdk --output=./cdk.out diff MyStack');
    expect(result?.allowed).toBe(true);
  });
});

describe('tokenizeCdkCommand — backslash escape outside quotes', () => {
  it('treats a backslash-escaped space as part of the current token', () => {
    expect(tokenizeCdkCommand('foo\\ bar')).toEqual(['foo bar']);
  });
});

describe('tokenizeCdkCommand — additional edge cases', () => {
  it('handles single-quoted multi-word value', () => {
    expect(tokenizeCdkCommand("cdk --app 'node app.js' diff")).toEqual([
      'cdk', '--app', 'node app.js', 'diff',
    ]);
  });

  it('handles double-quoted value with backslash-escaped inner quote', () => {
    expect(tokenizeCdkCommand('cdk --app "my \\"app\\"" diff')).toEqual([
      'cdk', '--app', 'my "app"', 'diff',
    ]);
  });

  it('collapses multiple spaces between tokens', () => {
    expect(tokenizeCdkCommand('cdk  ls')).toEqual(['cdk', 'ls']);
  });

  it('ignores trailing whitespace', () => {
    expect(tokenizeCdkCommand('cdk ls ')).toEqual(['cdk', 'ls']);
  });

  it('returns empty array for empty string', () => {
    expect(tokenizeCdkCommand('')).toEqual([]);
  });

  it('treats --key=value as a single token', () => {
    expect(tokenizeCdkCommand('cdk --output=./cdk.out diff')).toEqual([
      'cdk', '--output=./cdk.out', 'diff',
    ]);
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
