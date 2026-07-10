import { describe, it, expect, afterEach, vi } from 'vitest';
import * as v from 'valibot';
import {
  resolveTimeoutMs,
  clampLimit,
  buildLockdownNote,
  resolveConfigString,
  buildArgsInputSchema,
  resolveNamespaceLockdown,
} from '../tool-config.ts';

describe('resolveTimeoutMs', () => {
  it('returns the provided value when it is a positive finite number', () => {
    expect(resolveTimeoutMs(5_000, 15_000)).toBe(5_000);
    expect(resolveTimeoutMs(1, 15_000)).toBe(1);
    expect(resolveTimeoutMs(0.5, 15_000)).toBe(0.5);
  });

  it('returns defaultMs when rawTimeout is zero', () => {
    expect(resolveTimeoutMs(0, 15_000)).toBe(15_000);
  });

  it('returns defaultMs when rawTimeout is negative', () => {
    expect(resolveTimeoutMs(-1, 15_000)).toBe(15_000);
    expect(resolveTimeoutMs(-Infinity, 15_000)).toBe(15_000);
  });

  it('returns defaultMs when rawTimeout is Infinity', () => {
    expect(resolveTimeoutMs(Infinity, 15_000)).toBe(15_000);
  });

  it('returns defaultMs when rawTimeout is NaN', () => {
    expect(resolveTimeoutMs(NaN, 15_000)).toBe(15_000);
  });

  it('returns defaultMs when rawTimeout is null', () => {
    expect(resolveTimeoutMs(null, 15_000)).toBe(15_000);
  });

  it('returns defaultMs when rawTimeout is undefined', () => {
    expect(resolveTimeoutMs(undefined, 15_000)).toBe(15_000);
  });
});

describe('clampLimit', () => {
  it('returns the value unchanged when it is a positive finite integer within range', () => {
    expect(clampLimit(50, 20, 100)).toBe(50);
    expect(clampLimit(1, 20, 100)).toBe(1);
    expect(clampLimit(100, 20, 100)).toBe(100);
  });

  it('clamps to maxLimit when rawLimit exceeds it', () => {
    expect(clampLimit(150, 20, 100)).toBe(100);
    expect(clampLimit(10_000, 20, 100)).toBe(100);
  });

  it('truncates fractional values before clamping', () => {
    expect(clampLimit(2.9, 20, 100)).toBe(2);
    expect(clampLimit(0.9, 20, 100)).toBe(1);
  });

  it('clamps to 1 for zero', () => {
    expect(clampLimit(0, 20, 100)).toBe(1);
  });

  it('clamps to 1 for negative numbers (not defaultLimit)', () => {
    expect(clampLimit(-5, 20, 100)).toBe(1);
    expect(clampLimit(-1, 20, 100)).toBe(1);
  });

  it('returns defaultLimit for null', () => {
    expect(clampLimit(null, 20, 100)).toBe(20);
  });

  it('returns defaultLimit for undefined', () => {
    expect(clampLimit(undefined, 20, 100)).toBe(20);
  });

  it('returns defaultLimit for NaN', () => {
    expect(clampLimit(NaN, 20, 100)).toBe(20);
  });

  it('returns defaultLimit for Infinity', () => {
    expect(clampLimit(Infinity, 20, 100)).toBe(20);
    expect(clampLimit(-Infinity, 20, 100)).toBe(20);
  });
});

describe('buildLockdownNote', () => {
  it('returns the prefixed message when a namespace is locked', () => {
    expect(buildLockdownNote('prod', (ns) => `only '${ns}' is accessible.`)).toBe(
      " NAMESPACE LOCKDOWN ACTIVE: only 'prod' is accessible.",
    );
  });

  it('passes the narrowed namespace value to the message builder', () => {
    const message = (ns: string) => ns;
    expect(buildLockdownNote('kube-system', message)).toBe(' NAMESPACE LOCKDOWN ACTIVE: kube-system');
  });

  it('returns an empty string and does not invoke message when lockedNamespace is null', () => {
    const message = () => {
      throw new Error('should not be called');
    };
    expect(buildLockdownNote(null, message)).toBe('');
  });

  it('returns an empty string and does not invoke message when lockedNamespace is undefined', () => {
    const message = () => {
      throw new Error('should not be called');
    };
    expect(buildLockdownNote(undefined, message)).toBe('');
  });

  it('returns an empty string when lockedNamespace is an empty string', () => {
    const message = () => {
      throw new Error('should not be called');
    };
    expect(buildLockdownNote('', message)).toBe('');
  });
});

describe('buildArgsInputSchema', () => {
  it('accepts a plain args string', () => {
    const schema = buildArgsInputSchema('aws');
    expect(v.parse(schema, { args: 'ec2 describe-instances' })).toEqual({ args: 'ec2 describe-instances' });
  });

  it('rejects a non-string args value', () => {
    const schema = buildArgsInputSchema('aws');
    expect(() => v.parse(schema, { args: 42 })).toThrow();
  });

  it('describes the argument using the uppercased binary name as the CLI label', () => {
    const schema = buildArgsInputSchema('aws');
    expect(schema.entries.args.pipe[1]).toMatchObject({
      type: 'description',
      description: 'Arguments passed to the AWS CLI, excluding the leading "aws".',
    });
  });

  it('derives the label from whichever binary name is passed', () => {
    const schema = buildArgsInputSchema('cdk');
    expect(schema.entries.args.pipe[1]).toMatchObject({
      type: 'description',
      description: 'Arguments passed to the CDK CLI, excluding the leading "cdk".',
    });
  });

  it('normalizes a mixed-case binary name to lowercase in both the label and the exclusion note', () => {
    const schema = buildArgsInputSchema('Aws');
    expect(schema.entries.args.pipe[1]).toMatchObject({
      type: 'description',
      description: 'Arguments passed to the AWS CLI, excluding the leading "aws".',
    });
  });
});

describe('resolveNamespaceLockdown', () => {
  it('passes the requested namespace through unchanged when nothing is locked', () => {
    expect(resolveNamespaceLockdown('staging', undefined)).toEqual({ blocked: false, namespace: 'staging' });
  });

  it('resolves to undefined when nothing is locked and no namespace is requested', () => {
    expect(resolveNamespaceLockdown(undefined, undefined)).toEqual({ blocked: false, namespace: undefined });
    expect(resolveNamespaceLockdown(null, undefined)).toEqual({ blocked: false, namespace: undefined });
  });

  it('resolves to the locked namespace when none is requested', () => {
    expect(resolveNamespaceLockdown(undefined, 'prod')).toEqual({ blocked: false, namespace: 'prod' });
    expect(resolveNamespaceLockdown(null, 'prod')).toEqual({ blocked: false, namespace: 'prod' });
  });

  it('resolves to the locked namespace when the request matches it', () => {
    expect(resolveNamespaceLockdown('prod', 'prod')).toEqual({ blocked: false, namespace: 'prod' });
  });

  it('blocks when the request differs from the locked namespace', () => {
    expect(resolveNamespaceLockdown('staging', 'prod')).toEqual({ blocked: true });
  });
});

describe('resolveConfigString', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns configValue when set, without reading env', () => {
    vi.stubEnv('SOME_URL', 'http://env');
    expect(resolveConfigString('http://config', 'SOME_URL', 'http://default')).toBe('http://config');
  });

  it('falls back to the env var when configValue is absent', () => {
    vi.stubEnv('SOME_URL', 'http://env');
    expect(resolveConfigString(undefined, 'SOME_URL', 'http://default')).toBe('http://env');
    expect(resolveConfigString(null, 'SOME_URL', 'http://default')).toBe('http://env');
    expect(resolveConfigString('', 'SOME_URL', 'http://default')).toBe('http://env');
  });

  it('checks multiple env vars in order and uses the first truthy one', () => {
    vi.stubEnv('PRIMARY', '');
    vi.stubEnv('SECONDARY', 'secondary-value');
    expect(resolveConfigString(undefined, ['PRIMARY', 'SECONDARY'], 'default')).toBe('secondary-value');
  });

  it('returns fallback when configValue and all env vars are unset', () => {
    vi.stubEnv('SOME_URL', '');
    expect(resolveConfigString(undefined, 'SOME_URL', 'http://default')).toBe('http://default');
  });

  it('defaults fallback to an empty string when omitted', () => {
    vi.stubEnv('SOME_KEY', '');
    expect(resolveConfigString(undefined, 'SOME_KEY')).toBe('');
  });
});
