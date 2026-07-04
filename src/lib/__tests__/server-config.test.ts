import { describe, it, expect } from 'vitest';
import { resolveApiKey, resolveMetricsServiceName } from '../server-config.ts';

describe('resolveApiKey', () => {
  it('prefers the env value over the config value', () => {
    expect(resolveApiKey('env-secret', 'config-secret')).toBe('env-secret');
  });

  it('falls back to the config value when the env value is absent', () => {
    expect(resolveApiKey(undefined, 'config-secret')).toBe('config-secret');
  });

  it('trims whitespace from the resolved value', () => {
    expect(resolveApiKey('  env-secret  ', undefined)).toBe('env-secret');
  });

  it('an explicitly empty or whitespace-only env value resolves to undefined, even with a valid config value', () => {
    // Empty string is not nullish, so it is not skipped by `??` — the config
    // value is only used as a fallback when the env var is unset entirely.
    expect(resolveApiKey('', 'config-secret')).toBeUndefined();
    expect(resolveApiKey('   ', 'config-secret')).toBeUndefined();
  });

  it('returns undefined when both values are empty or absent', () => {
    expect(resolveApiKey(undefined, undefined)).toBeUndefined();
    expect(resolveApiKey(undefined, null)).toBeUndefined();
    expect(resolveApiKey('', '')).toBeUndefined();
    expect(resolveApiKey('   ', '   ')).toBeUndefined();
  });
});

describe('resolveMetricsServiceName', () => {
  it('prefers the config value over the env value', () => {
    expect(resolveMetricsServiceName('config-service', 'env-service')).toBe('config-service');
  });

  it('falls back to the env value when the config value is absent', () => {
    expect(resolveMetricsServiceName(undefined, 'env-service')).toBe('env-service');
    expect(resolveMetricsServiceName(null, 'env-service')).toBe('env-service');
  });

  it('trims whitespace from the resolved value', () => {
    expect(resolveMetricsServiceName('  config-service  ', undefined)).toBe('config-service');
    expect(resolveMetricsServiceName(undefined, '  env-service  ')).toBe('env-service');
  });

  it('falls through an empty or whitespace-only config value to env', () => {
    expect(resolveMetricsServiceName('', 'env-service')).toBe('env-service');
    expect(resolveMetricsServiceName('   ', 'env-service')).toBe('env-service');
  });

  it('returns undefined when both values are empty or absent', () => {
    expect(resolveMetricsServiceName(undefined, undefined)).toBeUndefined();
    expect(resolveMetricsServiceName(null, undefined)).toBeUndefined();
    expect(resolveMetricsServiceName('', '')).toBeUndefined();
  });
});
