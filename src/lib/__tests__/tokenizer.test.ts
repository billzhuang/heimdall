import { describe, it, expect } from 'vitest';
import { tokenizeShellArgs, joinShellArgs } from '../tokenizer.ts';

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

describe('tokenizeShellArgs — omitted binaryName', () => {
  it('keeps all tokens when binaryName is omitted', () => {
    expect(tokenizeShellArgs('cdk ls')).toEqual(['cdk', 'ls']);
  });

  it('keeps a leading cdk token (validator needs it to detect isCdk)', () => {
    expect(tokenizeShellArgs('cdk diff MyStack')).toEqual(['cdk', 'diff', 'MyStack']);
  });

  it('returns empty array for empty input when binaryName is omitted', () => {
    expect(tokenizeShellArgs('')).toEqual([]);
    expect(tokenizeShellArgs('   ')).toEqual([]);
  });

  it('handles quoted arguments when binaryName is omitted', () => {
    expect(tokenizeShellArgs("cdk --app 'node app.js' diff")).toEqual([
      'cdk', '--app', 'node app.js', 'diff',
    ]);
  });

  it('does not strip the first token even when it matches a known binary name', () => {
    // Without binaryName, 'kubectl' is kept — no implicit stripping.
    expect(tokenizeShellArgs('kubectl get pods')).toEqual(['kubectl', 'get', 'pods']);
  });
});

describe('joinShellArgs', () => {
  it('joins a binary name with simple args unquoted', () => {
    expect(joinShellArgs('kubectl', ['get', 'pods'])).toBe('kubectl get pods');
  });

  it('quotes an argument containing whitespace', () => {
    expect(joinShellArgs('kubectl', ['-l', 'app=my app'])).toBe(`kubectl -l 'app=my app'`);
  });

  it('quotes an argument containing a single quote and escapes it', () => {
    expect(joinShellArgs('aws', ["it's"])).toBe(`aws 'it'\\''s'`);
  });

  it('quotes an argument containing a double quote', () => {
    expect(joinShellArgs('kubectl', ['key="value"'])).toBe(`kubectl 'key="value"'`);
  });

  it('quotes an argument containing a backslash', () => {
    expect(joinShellArgs('aws', ['a\\b'])).toBe(`aws 'a\\b'`);
  });

  it('returns just the binary name for empty argv', () => {
    expect(joinShellArgs('trivy', [])).toBe('trivy');
  });

  it('round-trips with tokenizeShellArgs for plain args', () => {
    const argv = tokenizeShellArgs('get pods -n prod', 'kubectl');
    expect(joinShellArgs('kubectl', argv)).toBe('kubectl get pods -n prod');
  });
});
