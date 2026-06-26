import { describe, it, expect, vi } from 'vitest';
import { compileRules, applyRedaction } from '../regex-redact.ts';

// ---------------------------------------------------------------------------
// compileRules
// ---------------------------------------------------------------------------

describe('compileRules', () => {
  it('compiles a valid rule into a RegExp', () => {
    const rules = compileRules([{ name: 'aws_key', pattern: 'AKIA[0-9A-Z]{16}' }]);
    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe('aws_key');
    expect(rules[0].re).toBeInstanceOf(RegExp);
  });

  it('returns an empty array for an empty input', () => {
    expect(compileRules([])).toEqual([]);
  });

  it('skips an invalid pattern and logs a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rules = compileRules([{ name: 'bad', pattern: '[invalid(' }]);
    expect(rules).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"bad"'));
    warnSpy.mockRestore();
  });

  it('compiles multiple rules, skipping only the invalid one', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rules = compileRules([
      { name: 'good', pattern: 'AKIA[0-9A-Z]{16}' },
      { name: 'bad', pattern: '[(' },
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe('good');
    warnSpy.mockRestore();
  });

  it('compiles rules with the global flag so all occurrences are replaced', () => {
    const rules = compileRules([{ name: 'token', pattern: 'SECRET' }]);
    expect(rules[0].re.flags).toContain('g');
  });

  it('skips an empty pattern (bare `(?i)`) and logs a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rules = compileRules([{ name: 'empty', pattern: '(?i)' }]);
    expect(rules).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('empty after stripping'));
    warnSpy.mockRestore();
  });

  it('deduplicates flags from `(?ii)` without throwing', () => {
    const rules = compileRules([{ name: 'dup_flag', pattern: '(?ii)SECRET' }]);
    expect(rules).toHaveLength(1);
    // The `i` flag should appear exactly once
    expect(rules[0].re.flags.split('i').length - 1).toBe(1);
  });

  it('deduplicates when extraFlags contains `g`, preventing a SyntaxError', () => {
    // `(?g)` would previously produce flags='gg' which throws SyntaxError
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => compileRules([{ name: 'dup_g', pattern: '(?g)SECRET' }])).not.toThrow();
    warnSpy.mockRestore();
  });

  it('skips a pattern with nested quantifiers (potential ReDoS) and logs a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rules = compileRules([{ name: 'redos', pattern: '(a+)+b' }]);
    expect(rules).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('catastrophic backtracking'));
    warnSpy.mockRestore();
  });

  it('skips nested-quantifier variant (.+)+ and logs a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rules = compileRules([{ name: 'redos2', pattern: '(.+)+end' }]);
    expect(rules).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('catastrophic backtracking'));
    warnSpy.mockRestore();
  });

  it('allows a safe quantified non-capturing group like (?:foo)+', () => {
    const rules = compileRules([{ name: 'safe', pattern: '(?:foo)+bar' }]);
    expect(rules).toHaveLength(1);
  });

  it('handles multiple consecutive inline flag groups (?i)(?m)', () => {
    const rules = compileRules([{ name: 'multi_flag', pattern: '(?i)(?m)^secret=' }]);
    expect(rules).toHaveLength(1);
    expect(rules[0].re.flags).toContain('i');
    expect(rules[0].re.flags).toContain('m');
  });

  it('correctly applies both flags from (?i)(?m) so matching is case-insensitive and multiline', () => {
    const rules = compileRules([{ name: 'token', pattern: '(?i)(?m)^api_key=' }]);
    expect(rules).toHaveLength(1);
    // multiline: ^ matches after newline; case-insensitive: API_KEY matches
    expect(rules[0].re.test('prefix\nAPI_KEY=secret')).toBe(true);
  });

  it('skips a pattern that becomes empty after stripping multiple inline flag groups', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rules = compileRules([{ name: 'empty_multi', pattern: '(?i)(?m)' }]);
    expect(rules).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('empty after stripping'));
    warnSpy.mockRestore();
  });

  it('skips a nested-quantifier {n,} variant (a+){2,} as a ReDoS risk', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rules = compileRules([{ name: 'redos3', pattern: '(a+){2,}b' }]);
    expect(rules).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('catastrophic backtracking'));
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// applyRedaction
// ---------------------------------------------------------------------------

describe('applyRedaction', () => {
  it('returns the text unchanged when rules is empty', () => {
    expect(applyRedaction('some text with AKIAIOSFODNN7EXAMPLE', [])).toBe('some text with AKIAIOSFODNN7EXAMPLE');
  });

  it('returns empty string unchanged', () => {
    const rules = compileRules([{ name: 'token', pattern: 'SECRET' }]);
    expect(applyRedaction('', rules)).toBe('');
  });

  it('redacts a matching AWS access key', () => {
    const rules = compileRules([{ name: 'aws_access_key', pattern: 'AKIA[0-9A-Z]{16}' }]);
    const input = 'env: AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
    const result = applyRedaction(input, rules);
    expect(result).toContain('[REDACTED:aws_access_key]');
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts a PEM private key header', () => {
    const rules = compileRules([{ name: 'private_key_pem', pattern: '-----BEGIN( RSA)? PRIVATE KEY-----' }]);
    const input = 'tls.key: |\n  -----BEGIN RSA PRIVATE KEY-----\n  MIIEowIBAAK...';
    const result = applyRedaction(input, rules);
    expect(result).toContain('[REDACTED:private_key_pem]');
    expect(result).not.toContain('-----BEGIN RSA PRIVATE KEY-----');
  });

  it('redacts all occurrences when the same pattern appears multiple times', () => {
    const rules = compileRules([{ name: 'aws_access_key', pattern: 'AKIA[0-9A-Z]{16}' }]);
    const input = 'key1=AKIAIOSFODNN7EXAMPLE key2=AKIAI44QH8DHBEXAMPLE';
    const result = applyRedaction(input, rules);
    expect(result.split('[REDACTED:aws_access_key]')).toHaveLength(3);
    expect(result).not.toContain('AKIA');
  });

  it('applies multiple rules in order', () => {
    const rules = compileRules([
      { name: 'aws_access_key', pattern: 'AKIA[0-9A-Z]{16}' },
      { name: 'bearer_token', pattern: 'Bearer [A-Za-z0-9._-]{20,}' },
    ]);
    const input = 'key=AKIAIOSFODNN7EXAMPLE auth=Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9';
    const result = applyRedaction(input, rules);
    expect(result).toContain('[REDACTED:aws_access_key]');
    expect(result).toContain('[REDACTED:bearer_token]');
    expect(result).not.toContain('AKIA');
    expect(result).not.toContain('Bearer ey');
  });

  it('does not mutate the text when no pattern matches', () => {
    const rules = compileRules([{ name: 'aws_access_key', pattern: 'AKIA[0-9A-Z]{16}' }]);
    const input = 'kubectl get pods -n prod';
    expect(applyRedaction(input, rules)).toBe(input);
  });

  it('resets regex lastIndex between calls (safe for repeated use)', () => {
    const rules = compileRules([{ name: 'token', pattern: 'TOKEN[0-9]+' }]);
    const input = 'TOKEN123 and TOKEN456';
    // Call twice: if lastIndex is not reset, the second call on a global regex
    // would start from where the first left off and miss matches.
    expect(applyRedaction(input, rules)).toContain('[REDACTED:token]');
    expect(applyRedaction(input, rules)).toContain('[REDACTED:token]');
  });

  it('handles a case-insensitive flag in the pattern', () => {
    const rules = compileRules([{ name: 'secret', pattern: '(?i)secret=[A-Za-z0-9]{10,}' }]);
    const input = 'SECRET=abcdefghij12';
    const result = applyRedaction(input, rules);
    expect(result).toContain('[REDACTED:secret]');
  });

  it('redacts matches across multiple lines when the multiline flag is set', () => {
    const rules = compileRules([{ name: 'api_key', pattern: '(?m)^API_KEY=[^\n]+' }]);
    const input = 'HOST=prod.example.com\nAPI_KEY=supersecret123\nPORT=8080';
    const result = applyRedaction(input, rules);
    expect(result).toContain('[REDACTED:api_key]');
    expect(result).not.toContain('supersecret123');
    expect(result).toContain('HOST=prod.example.com');
    expect(result).toContain('PORT=8080');
  });

  it('redacts using combined (?i)(?m) flags compiled from separate groups', () => {
    const rules = compileRules([{ name: 'key', pattern: '(?i)(?m)^secret=[^\n]+' }]);
    const input = 'noise\nSECRET=topsecret42\nmore';
    const result = applyRedaction(input, rules);
    expect(result).toContain('[REDACTED:key]');
    expect(result).not.toContain('topsecret42');
  });
});

// ---------------------------------------------------------------------------
// Integration: disabled by default (no rules → no change)
// ---------------------------------------------------------------------------

describe('applyRedaction — disabled scenario', () => {
  it('when redaction is disabled (empty rules), sensitive text passes through unchanged', () => {
    const sensitiveOutput = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    // Caller passes [] when redaction.enabled is false — nothing is redacted.
    expect(applyRedaction(sensitiveOutput, [])).toBe(sensitiveOutput);
  });
});
