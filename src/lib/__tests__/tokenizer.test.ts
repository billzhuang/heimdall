import { describe, it, expect } from 'vitest';
import { tokenize, tokenizeShellArgs } from '../tokenizer.ts';

describe('tokenizeShellArgs', () => {
  it('splits simple space-separated args', () => {
    expect(tokenizeShellArgs('get pods', 'kubectl')).toEqual(['get', 'pods']);
  });

  it('strips leading binary name (case-insensitive)', () => {
    expect(tokenizeShellArgs('kubectl get pods', 'kubectl')).toEqual(['get', 'pods']);
    expect(tokenizeShellArgs('KUBECTL get pods', 'kubectl')).toEqual(['get', 'pods']);
  });

  it('does not strip other leading tokens', () => {
    expect(tokenizeShellArgs('aws ec2 describe-instances', 'kubectl')).toEqual([
      'aws',
      'ec2',
      'describe-instances',
    ]);
  });

  it('handles single-quoted strings', () => {
    expect(tokenizeShellArgs("get pods -l 'app=my app'", 'kubectl')).toEqual([
      'get',
      'pods',
      '-l',
      'app=my app',
    ]);
  });

  it('handles double-quoted strings', () => {
    expect(tokenizeShellArgs('get pods -l "app=my app"', 'kubectl')).toEqual([
      'get',
      'pods',
      '-l',
      'app=my app',
    ]);
  });

  it('handles backslash escapes in double quotes', () => {
    expect(tokenizeShellArgs('get pods -l "key=\\"value\\""', 'kubectl')).toEqual([
      'get',
      'pods',
      '-l',
      'key="value"',
    ]);
  });

  it('handles backslash escape outside quotes', () => {
    expect(tokenizeShellArgs('get\\ pods', 'kubectl')).toEqual(['get pods']);
  });

  it('returns empty array for empty input', () => {
    expect(tokenizeShellArgs('', 'kubectl')).toEqual([]);
    expect(tokenizeShellArgs('   ', 'kubectl')).toEqual([]);
  });

  it('strips the aws binary name correctly', () => {
    expect(tokenizeShellArgs('aws ec2 describe-instances', 'aws')).toEqual([
      'ec2',
      'describe-instances',
    ]);
  });

  it('empty single-quoted string produces an empty-string token', () => {
    expect(tokenizeShellArgs("''", 'kubectl')).toEqual(['']);
  });

  it('empty double-quoted string produces an empty-string token', () => {
    expect(tokenizeShellArgs('""', 'kubectl')).toEqual(['']);
  });

  it('single quote inside double-quoted string is treated as a literal character', () => {
    expect(tokenizeShellArgs(`"it's"`, 'kubectl')).toEqual(["it's"]);
  });

  it('unrecognized escape sequence in double quotes preserves the backslash literally', () => {
    // `\n` is not a recognized double-quote escape (only `\"` and `\\` are) — backslash kept.
    expect(tokenizeShellArgs('"\\n"', 'kubectl')).toEqual(['\\n']);
  });

  it('adjacent single-quoted tokens without whitespace concatenate into one token', () => {
    expect(tokenizeShellArgs("'foo''bar'", 'kubectl')).toEqual(['foobar']);
  });
});

describe('tokenize', () => {
  it('returns all tokens without stripping any binary name', () => {
    expect(tokenize('cdk ls')).toEqual(['cdk', 'ls']);
    expect(tokenize('kubectl get pods')).toEqual(['kubectl', 'get', 'pods']);
  });

  it('returns empty array for empty or whitespace input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });

  it('handles single-quoted strings', () => {
    expect(tokenize("cdk --app 'node app.js' diff")).toEqual(['cdk', '--app', 'node app.js', 'diff']);
  });

  it('handles double-quoted strings', () => {
    expect(tokenize('cdk --app "node app.js" diff')).toEqual(['cdk', '--app', 'node app.js', 'diff']);
  });

  it('handles backslash escape outside quotes', () => {
    expect(tokenize('foo\\ bar')).toEqual(['foo bar']);
  });

  it('handles backslash-escaped quote inside double quotes', () => {
    expect(tokenize('cdk --app "my \\"app\\"" diff')).toEqual(['cdk', '--app', 'my "app"', 'diff']);
  });

  it('handles unrecognized escape in double quotes — preserves backslash', () => {
    expect(tokenize('"\\n"')).toEqual(['\\n']);
  });

  it('tokenizeShellArgs strips only the matching binary name token', () => {
    // tokenize returns ['cdk', 'ls']; tokenizeShellArgs with 'cdk' strips the first token
    expect(tokenizeShellArgs('cdk ls', 'cdk')).toEqual(['ls']);
    // tokenize returns ['KUBECTL', 'get', 'pods']; strip 'kubectl' case-insensitively
    expect(tokenizeShellArgs('KUBECTL get pods', 'kubectl')).toEqual(['get', 'pods']);
    // first token does not match — no stripping
    expect(tokenizeShellArgs('aws ec2 describe-instances', 'kubectl')).toEqual([
      'aws', 'ec2', 'describe-instances',
    ]);
  });
});
