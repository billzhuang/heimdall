import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { redactSecretValues, isGetSecretCommand, REDACTED_FORMAT_MESSAGE } from '../redact.ts';

// ── isGetSecretCommand ───────────────────────────────────────────────────────

describe('isGetSecretCommand', () => {
  it('returns true for "get secret"', () => {
    expect(isGetSecretCommand(['get', 'secret', 'foo'])).toBe(true);
  });

  it('returns true for "get secrets"', () => {
    expect(isGetSecretCommand(['get', 'secrets', '-n', 'prod'])).toBe(true);
  });

  it('returns true for "get secret/<name>"', () => {
    expect(isGetSecretCommand(['get', 'secret/db-creds', '-o', 'json'])).toBe(true);
  });

  it('returns false for "get pods"', () => {
    expect(isGetSecretCommand(['get', 'pods'])).toBe(false);
  });

  it('returns false for "get configmap"', () => {
    expect(isGetSecretCommand(['get', 'configmap', 'foo'])).toBe(false);
  });

  it('returns false for non-get subcommands', () => {
    expect(isGetSecretCommand(['describe', 'secret', 'foo'])).toBe(false);
  });

  it('returns false for empty argv', () => {
    expect(isGetSecretCommand([])).toBe(false);
  });

  it('skips value-taking flags before the resource type', () => {
    expect(isGetSecretCommand(['get', '-n', 'prod', 'secret', 'foo'])).toBe(true);
    expect(isGetSecretCommand(['get', '--namespace', 'prod', 'secrets'])).toBe(true);
    expect(isGetSecretCommand(['get', '-o', 'json', 'secret', 'foo'])).toBe(true);
  });

  it('handles --context= prepended by runKubectl (global flag before get)', () => {
    expect(isGetSecretCommand(['--context=prod', 'get', 'secret', 'foo', '-o', 'jsonpath=...'])).toBe(true);
    expect(isGetSecretCommand(['--context=prod', 'get', 'pods'])).toBe(false);
  });

  it('handles comma-separated resource types containing secret', () => {
    expect(isGetSecretCommand(['get', 'secret,configmap', '-o', 'json'])).toBe(true);
    expect(isGetSecretCommand(['get', 'configmap,secret', '-n', 'prod'])).toBe(true);
  });

  it('returns false for comma-separated types with no secret', () => {
    expect(isGetSecretCommand(['get', 'pod,configmap'])).toBe(false);
  });
});

// ── redactSecretValues — JSON ────────────────────────────────────────────────

const secretJson = (data: Record<string, string>, stringData?: Record<string, string>) =>
  JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'db-creds', namespace: 'prod' },
    type: 'Opaque',
    ...(data ? { data } : {}),
    ...(stringData ? { stringData } : {}),
  });

const argv = (format: string) => ['get', 'secret', 'db-creds', '-o', format];

describe('redactSecretValues — JSON', () => {
  it('redacts .data values and preserves keys', () => {
    const output = secretJson({ password: 'dGVzdA==' });
    const result = redactSecretValues(output, argv('json'));
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect((parsed['data'] as Record<string, string>)['password']).toMatch(/^<redacted: \d+ bytes>$/);
  });

  it('redacts .stringData values', () => {
    const output = secretJson({}, { token: 'my-secret-token' });
    const result = redactSecretValues(output, argv('json'));
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect((parsed['stringData'] as Record<string, string>)['token']).toMatch(/^<redacted: \d+ bytes>$/);
  });

  it('preserves metadata, kind, apiVersion, and type', () => {
    const output = secretJson({ key: 'dmFsdWU=' });
    const result = redactSecretValues(output, argv('json'));
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed['kind']).toBe('Secret');
    expect((parsed['metadata'] as Record<string, string>)['name']).toBe('db-creds');
    expect(parsed['type']).toBe('Opaque');
  });

  it('redacts all keys in .data', () => {
    const output = secretJson({ username: 'dXNlcg==', password: 'cGFzcw==' });
    const result = redactSecretValues(output, argv('json'));
    const parsed = JSON.parse(result) as Record<string, unknown>;
    const data = parsed['data'] as Record<string, string>;
    expect(data['username']).toMatch(/^<redacted: \d+ bytes>$/);
    expect(data['password']).toMatch(/^<redacted: \d+ bytes>$/);
  });

  it('redacts Secrets inside a List', () => {
    const list = {
      apiVersion: 'v1',
      kind: 'List',
      items: [
        { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'a' }, data: { key: 'c2VjcmV0' } },
        { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'b' }, data: { key: 'c2VjcmV0' } },
      ],
    };
    const result = redactSecretValues(JSON.stringify(list), ['get', 'secrets', '-o', 'json']);
    const parsed = JSON.parse(result) as { items: Array<Record<string, unknown>> };
    for (const item of parsed.items) {
      const data = item['data'] as Record<string, string>;
      expect(data['key']).toMatch(/^<redacted: \d+ bytes>$/);
    }
  });

  it('passes through non-Secret JSON unchanged', () => {
    const pod = JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'web' }, spec: {} });
    expect(redactSecretValues(pod, ['get', 'pod', 'web', '-o', 'json'])).toBe(pod);
  });

  it('passes through invalid JSON unchanged', () => {
    const broken = 'not valid json {{';
    expect(redactSecretValues(broken, argv('json'))).toBe(broken);
  });

  it('byte count for base64 is approximately correct', () => {
    // "test" base64 = "dGVzdA==" → 4 bytes
    const output = secretJson({ password: 'dGVzdA==' });
    const result = redactSecretValues(output, argv('json'));
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect((parsed['data'] as Record<string, string>)['password']).toBe('<redacted: 4 bytes>');
  });

  it('byte count for stringData uses string length', () => {
    const output = secretJson({}, { token: 'hello' });
    const result = redactSecretValues(output, argv('json'));
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect((parsed['stringData'] as Record<string, string>)['token']).toBe('<redacted: 5 bytes>');
  });

  it('handles Secret with no data or stringData fields', () => {
    const empty = JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'tls' }, type: 'kubernetes.io/tls' });
    const result = redactSecretValues(empty, argv('json'));
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed['kind']).toBe('Secret');
    expect(parsed['data']).toBeUndefined();
  });
});

// ── redactSecretValues — YAML ────────────────────────────────────────────────

describe('redactSecretValues — YAML', () => {
  const yamlSecret = `apiVersion: v1
kind: Secret
metadata:
  name: db-creds
  namespace: prod
type: Opaque
data:
  password: dGVzdA==
  username: dXNlcg==
`;

  it('redacts .data values in YAML output', () => {
    const result = redactSecretValues(yamlSecret, argv('yaml'));
    expect(result).toContain('password:');
    expect(result).not.toContain('dGVzdA==');
    expect(result).toMatch(/<redacted: \d+ bytes>/);
  });

  it('preserves metadata in YAML output', () => {
    const result = redactSecretValues(yamlSecret, argv('yaml'));
    expect(result).toContain('name: db-creds');
    expect(result).toContain('kind: Secret');
  });

  it('passes through non-Secret YAML unchanged', () => {
    const cm = `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  key: value
`;
    expect(redactSecretValues(cm, ['get', 'configmap', 'app-config', '-o', 'yaml'])).toBe(cm);
  });

  it('passes through invalid YAML unchanged', () => {
    const broken = ': invalid: [yaml';
    expect(redactSecretValues(broken, argv('yaml'))).toBe(broken);
  });
});

// ── redactSecretValues — non-JSON/YAML formats ───────────────────────────────

describe('redactSecretValues — other formats', () => {
  it('blocks jsonpath on get secret with REDACTED_FORMAT_MESSAGE', () => {
    const result = redactSecretValues('dGVzdA==', [
      'get', 'secret', 'db-creds', '-o', 'jsonpath={.data.password}',
    ]);
    expect(result).toBe(REDACTED_FORMAT_MESSAGE);
  });

  it('redacts when format is -ojson (attached, no space)', () => {
    const output = secretJson({ password: 'dGVzdA==' });
    const result = redactSecretValues(output, ['get', 'secret', 'db-creds', '-ojson']);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect((parsed['data'] as Record<string, string>)['password']).toMatch(/^<redacted:/);
  });

  it('redacts when format is -oyaml (attached, no space)', () => {
    const yamlSecret = `apiVersion: v1\nkind: Secret\nmetadata:\n  name: x\ndata:\n  key: c2VjcmV0\n`;
    const result = redactSecretValues(yamlSecret, ['get', 'secret', 'x', '-oyaml']);
    expect(result).toMatch(/<redacted: \d+ bytes>/);
  });

  it('blocks go-template on get secret with REDACTED_FORMAT_MESSAGE', () => {
    const result = redactSecretValues('dGVzdA==', [
      'get', 'secret', 'foo', '-o', 'go-template={{.data.token}}',
    ]);
    expect(result).toBe(REDACTED_FORMAT_MESSAGE);
  });

  it('passes through non-secret non-JSON/YAML output unchanged', () => {
    const output = 'NAME   READY   STATUS\nweb    1/1     Running';
    const result = redactSecretValues(output, ['get', 'pods', '-o', 'wide']);
    expect(result).toBe(output);
  });

  it('passes through output when no -o flag is present (default table)', () => {
    const output = 'NAME       TYPE     DATA   AGE\ndb-creds   Opaque   2      1d';
    const result = redactSecretValues(output, ['get', 'secret', 'db-creds']);
    // No format flag → 'other' format, but table output for secrets doesn't include values
    expect(result).toBe(REDACTED_FORMAT_MESSAGE);
  });

  it('returns unchanged output for empty string', () => {
    expect(redactSecretValues('', argv('json'))).toBe('');
  });
});

// ── Property-based tests ─────────────────────────────────────────────────────

describe('redactSecretValues — property tests', () => {
  const base64Char = fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split(''));
  const base64String = fc.array(base64Char, { minLength: 1, maxLength: 64 }).map((a) => a.join(''));

  it('no Secret data value ever passes through JSON output', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), base64String, { minKeys: 1, maxKeys: 5 }),
        (data) => {
          const secret = JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'test' }, data });
          const result = redactSecretValues(secret, ['get', 'secret', 'test', '-o', 'json']);
          const parsed = JSON.parse(result) as { data: Record<string, string> };
          for (const [key, val] of Object.entries(parsed.data)) {
            expect(val).toMatch(/^<redacted: \d+ bytes>$/);
            expect(val).not.toBe(data[key]);
          }
        },
      ),
    );
  });

  it('no Secret stringData value ever passes through JSON output', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.string({ minLength: 1, maxLength: 50 }), { minKeys: 1, maxKeys: 5 }),
        (stringData) => {
          const secret = JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'test' }, stringData });
          const result = redactSecretValues(secret, ['get', 'secret', 'test', '-o', 'json']);
          const parsed = JSON.parse(result) as { stringData: Record<string, string> };
          for (const [key, val] of Object.entries(parsed.stringData)) {
            expect(val).toMatch(/^<redacted: \d+ bytes>$/);
            expect(val).not.toBe(stringData[key]);
          }
        },
      ),
    );
  });

  it('non-Secret JSON is always returned unchanged', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('Pod', 'ConfigMap', 'Deployment', 'Service', 'Namespace'),
        fc.string(),
        (kind, name) => {
          const obj = JSON.stringify({ apiVersion: 'v1', kind, metadata: { name } });
          const result = redactSecretValues(obj, ['get', kind.toLowerCase(), name, '-o', 'json']);
          expect(result).toBe(obj);
        },
      ),
    );
  });
});
