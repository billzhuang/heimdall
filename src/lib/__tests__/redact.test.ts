import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  redactSecretValues,
  isGetSecretCommand,
  estimateBase64Bytes,
  REDACTED_FORMAT_MESSAGE,
  detectFormat,
  isSecretResource,
  containsSecret,
  redactDataFields,
  redactObject,
} from '../redact.ts';

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

  it('returns false when "get" is followed only by flags (no resource type)', () => {
    // All tokens after 'get' are flags — the while loop exhausts without a resource token.
    expect(isGetSecretCommand(['get', '--all-namespaces', '-o', 'json'])).toBe(false);
    expect(isGetSecretCommand(['get', '-A'])).toBe(false);
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

  it('skips value-taking global flags without = before "get" (bare --context)', () => {
    expect(isGetSecretCommand(['--context', 'prod-cluster', 'get', 'secret', 'foo'])).toBe(true);
    expect(isGetSecretCommand(['--context', 'prod-cluster', 'get', 'pods'])).toBe(false);
  });

  it('handles value-taking flags that shift resource position (--request-timeout bypass fix)', () => {
    // Without the fix, --request-timeout consumes its value token, but if not in the set
    // the value '5s' would be treated as the resource type and return false.
    expect(isGetSecretCommand(['get', '--request-timeout', '5s', 'secret', 'db'])).toBe(true);
    expect(isGetSecretCommand(['get', '--request-timeout', '5s', 'pods'])).toBe(false);
  });

  it('handles comma-separated resource types containing secret', () => {
    expect(isGetSecretCommand(['get', 'secret,configmap', '-o', 'json'])).toBe(true);
    expect(isGetSecretCommand(['get', 'configmap,secret', '-n', 'prod'])).toBe(true);
  });

  it('returns false for comma-separated types with no secret', () => {
    expect(isGetSecretCommand(['get', 'pod,configmap'])).toBe(false);
  });
});

// ── estimateBase64Bytes ──────────────────────────────────────────────────────

describe('estimateBase64Bytes', () => {
  it('returns 0 for an empty string', () => {
    expect(estimateBase64Bytes('')).toBe(0);
  });

  it('returns the correct byte count for "dGVzdA==" (encodes "test", 4 bytes)', () => {
    expect(estimateBase64Bytes('dGVzdA==')).toBe(4);
  });

  it('returns the correct byte count for "aGVsbG8=" (encodes "hello", 5 bytes)', () => {
    expect(estimateBase64Bytes('aGVsbG8=')).toBe(5);
  });

  it('returns the correct byte count for unpadded base64', () => {
    // "abc" base64-encodes to "YWJj" (no padding, 3 bytes)
    expect(estimateBase64Bytes('YWJj')).toBe(3);
  });

  it('property: result is always non-negative', () => {
    fc.assert(
      fc.property(
        fc.string(),
        (s) => estimateBase64Bytes(s) >= 0,
      ),
    );
  });

  it('handles base64 strings with internal newlines and trailing whitespace (YAML block scalars)', () => {
    // "test" splits as "dGVz\ndA==\n" when parsed from a YAML block scalar
    expect(estimateBase64Bytes('dGVz\ndA==\n')).toBe(4);
  });

  it('property: stripping padding never increases the estimate', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 64 }),
        (s) => {
          const withPad = s + '==';
          // estimate with padding stripped should equal estimate without
          expect(estimateBase64Bytes(withPad)).toBe(estimateBase64Bytes(s));
        },
      ),
    );
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

  it('redacts Secrets inside a mixed List while leaving non-Secret items unchanged', () => {
    const list = JSON.stringify({
      apiVersion: 'v1',
      kind: 'List',
      items: [
        { kind: 'Pod', metadata: { name: 'api-0' }, spec: { containers: [] } },
        { kind: 'Secret', metadata: { name: 'db-creds' }, data: { password: 'c2VjcmV0' } },
      ],
    });
    const result = redactSecretValues(list, ['get', 'all', '-o', 'json']);
    const parsed = JSON.parse(result) as { items: Array<{ kind: string; data?: Record<string, string>; spec?: unknown }> };
    const pod = parsed.items.find((i) => i.kind === 'Pod')!;
    const secret = parsed.items.find((i) => i.kind === 'Secret')!;
    // Pod passes through unchanged (redactObject line 120: return obj for non-Secret/List)
    expect(pod.spec).toBeDefined();
    // Secret data is redacted
    expect(secret.data!['password']).toMatch(/^<redacted:/);
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

  it('passes through JSON array output unchanged (containsSecret returns false for arrays)', () => {
    const arr = '[{"kind":"Secret","data":{"key":"dmFsdWU="}}]';
    expect(redactSecretValues(arr, ['get', 'secret', '-o', 'json'])).toBe(arr);
  });

  it('handles non-string Secret data values (number and null)', () => {
    const secretWithMixedTypes = JSON.stringify({
      apiVersion: 'v1',
      kind: 'Secret',
      data: { numeric: 42, missing: null },
    });
    const result = redactSecretValues(secretWithMixedTypes, argv('json'));
    const parsed = JSON.parse(result) as Record<string, unknown>;
    const data = parsed['data'] as Record<string, string>;
    expect(data['numeric']).toMatch(/^<redacted: \d+ bytes>$/);
    expect(data['missing']).toMatch(/^<redacted: \d+ bytes>$/);
  });

  it('byte count for base64 is approximately correct', () => {
    // "test" base64 = "dGVzdA==" → 4 bytes
    const output = secretJson({ password: 'dGVzdA==' });
    const result = redactSecretValues(output, argv('json'));
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect((parsed['data'] as Record<string, string>)['password']).toBe('<redacted: 4 bytes>');
  });

  it('byte count for stringData uses UTF-8 byte length', () => {
    const output = secretJson({}, { token: 'hello' });
    const result = redactSecretValues(output, argv('json'));
    const parsed = JSON.parse(result) as Record<string, unknown>;
    // 'hello' is 5 ASCII bytes
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

  it('handles multi-doc YAML containing a null document alongside a Secret', () => {
    const multiDoc =
      `null\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: s\ndata:\n  key: dmFsdWU=\n`;
    const result = redactSecretValues(multiDoc, argv('yaml'));
    expect(result).toMatch(/<redacted: \d+ bytes>/);
    expect(result).not.toContain('dmFsdWU=');
  });

  it('redacts multiple Secrets in a multi-document YAML stream', () => {
    const multiDoc =
      `apiVersion: v1\nkind: Secret\nmetadata:\n  name: secret-1\ndata:\n  key: dmFsdWUx\n` +
      `---\n` +
      `apiVersion: v1\nkind: Secret\nmetadata:\n  name: secret-2\ndata:\n  key: dmFsdWUy\n`;
    const result = redactSecretValues(multiDoc, argv('yaml'));
    expect(result).not.toContain('dmFsdWUx');
    expect(result).not.toContain('dmFsdWUy');
    expect(result).toContain('secret-1');
    expect(result).toContain('secret-2');
    expect(result).toMatch(/<redacted: \d+ bytes>/);
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

  it('redacts when format is --output json (long flag, space-separated)', () => {
    const output = secretJson({ password: 'dGVzdA==' });
    const result = redactSecretValues(output, ['get', 'secret', 'db-creds', '--output', 'json']);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect((parsed['data'] as Record<string, string>)['password']).toMatch(/^<redacted:/);
  });

  it('redacts when format is --output yaml (long flag, space-separated)', () => {
    const yamlSecret = `apiVersion: v1\nkind: Secret\nmetadata:\n  name: x\ndata:\n  key: c2VjcmV0\n`;
    const result = redactSecretValues(yamlSecret, ['get', 'secret', 'x', '--output', 'yaml']);
    expect(result).toMatch(/<redacted: \d+ bytes>/);
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

  it('blocks jsonpath on get secrets.v1 (dotted TYPE.VERSION qualifier) with REDACTED_FORMAT_MESSAGE', () => {
    // Without recognising the dotted qualifier form, this would slip past the
    // guard and leak the raw base64 secret value in a non-JSON/YAML format.
    const result = redactSecretValues('dGVzdA==', [
      'get', 'secrets.v1', 'db-creds', '-o', 'jsonpath={.data.password}',
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

// ── detectFormat ─────────────────────────────────────────────────────────────

describe('detectFormat', () => {
  it('returns "json" for -o json (separated)', () => {
    expect(detectFormat(['-o', 'json'])).toBe('json');
  });

  it('returns "yaml" for -o yaml (separated)', () => {
    expect(detectFormat(['-o', 'yaml'])).toBe('yaml');
  });

  it('returns "json" for -ojson (attached)', () => {
    expect(detectFormat(['-ojson'])).toBe('json');
  });

  it('returns "yaml" for -oyaml (attached)', () => {
    expect(detectFormat(['-oyaml'])).toBe('yaml');
  });

  it('returns "json" for --output=json', () => {
    expect(detectFormat(['--output=json'])).toBe('json');
  });

  it('returns "yaml" for --output=yaml', () => {
    expect(detectFormat(['--output=yaml'])).toBe('yaml');
  });

  it('returns "json" for --output json (separated)', () => {
    expect(detectFormat(['--output', 'json'])).toBe('json');
  });

  it('returns "yaml" for --output yaml (separated)', () => {
    expect(detectFormat(['--output', 'yaml'])).toBe('yaml');
  });

  it('returns "other" for unknown format value', () => {
    expect(detectFormat(['-o', 'jsonpath={.data}'])).toBe('other');
    expect(detectFormat(['-o', 'go-template={{.data}}'])).toBe('other');
    expect(detectFormat(['-o', 'wide'])).toBe('other');
    expect(detectFormat(['--output', 'custom-columns=...'])).toBe('other');
  });

  it('returns "other" when no -o flag is present', () => {
    expect(detectFormat([])).toBe('other');
    expect(detectFormat(['get', 'pods'])).toBe('other');
  });

  it('picks up the -o flag anywhere in the argv list', () => {
    expect(detectFormat(['get', 'secret', 'foo', '-o', 'json'])).toBe('json');
    expect(detectFormat(['get', 'secret', 'foo', '-ojson'])).toBe('json');
  });

  it('respects the last -o flag when multiple are specified (last-one-wins)', () => {
    // detectFormat scans the full argv and returns the last matched format,
    // matching kubectl's own flag semantics.
    expect(detectFormat(['-o', 'json', '-o', 'yaml'])).toBe('yaml');
    expect(detectFormat(['-o', 'yaml', '-o', 'json'])).toBe('json');
    expect(detectFormat(['-o', 'json', '-o', 'wide'])).toBe('other');
    expect(detectFormat(['-o', 'wide', '-o', 'json'])).toBe('json');
    expect(detectFormat(['-o', 'json', '-o=jsonpath={.data}'])).toBe('other');
    expect(detectFormat(['-ojson', '-oyaml'])).toBe('yaml');
    expect(detectFormat(['-oyaml', '-ojson'])).toBe('json');
  });

  it('handles -o=json (equals form without --)', () => {
    // -o=json is handled the same as -ojson by the parser
    expect(detectFormat(['-o=json'])).toBe('json');
    expect(detectFormat(['-o=yaml'])).toBe('yaml');
  });
});

// ── isSecretResource ──────────────────────────────────────────────────────────

describe('isSecretResource', () => {
  it('matches "secret" (singular, lowercase)', () => {
    expect(isSecretResource('secret')).toBe(true);
  });

  it('matches "secrets" (plural)', () => {
    expect(isSecretResource('secrets')).toBe(true);
  });

  it('matches "Secret" (capitalised)', () => {
    expect(isSecretResource('Secret')).toBe(true);
  });

  it('matches "SECRETS" (all-caps)', () => {
    expect(isSecretResource('SECRETS')).toBe(true);
  });

  it('matches "secret/<name>" form', () => {
    expect(isSecretResource('secret/db-creds')).toBe(true);
    expect(isSecretResource('secrets/my-token')).toBe(true);
  });

  it('does not match other resource types', () => {
    expect(isSecretResource('pod')).toBe(false);
    expect(isSecretResource('configmap')).toBe(false);
    expect(isSecretResource('serviceaccount')).toBe(false);
    expect(isSecretResource('')).toBe(false);
  });

  it('matches when secret appears in a comma-separated list', () => {
    expect(isSecretResource('secret,configmap')).toBe(true);
    expect(isSecretResource('configmap,secret')).toBe(true);
    expect(isSecretResource('pod,secret,service')).toBe(true);
  });

  it('does not match when no part of a comma-separated list is a secret', () => {
    expect(isSecretResource('pod,configmap,service')).toBe(false);
  });

  it('does not match a token that merely contains "secret" as a substring', () => {
    // "supersecret" should not match — it's not exactly "secret"
    expect(isSecretResource('supersecret')).toBe(false);
  });

  it('matches kubectl\'s dotted TYPE.VERSION.GROUP qualifier form', () => {
    expect(isSecretResource('secrets.v1')).toBe(true);
    expect(isSecretResource('secret.v1')).toBe(true);
    expect(isSecretResource('secrets.v1.')).toBe(true);
  });

  it('matches dotted qualifier combined with a slash-prefixed name', () => {
    expect(isSecretResource('secrets.v1/db-creds')).toBe(true);
  });

  it('matches dotted qualifier within a comma-separated list', () => {
    expect(isSecretResource('secrets.v1,configmap')).toBe(true);
  });

  it('does not match an unrelated dotted resource type', () => {
    expect(isSecretResource('pods.v1')).toBe(false);
  });
});

// ── containsSecret ────────────────────────────────────────────────────────────

describe('containsSecret', () => {
  it('returns true for a plain Secret object', () => {
    expect(containsSecret({ kind: 'Secret', apiVersion: 'v1', data: {} })).toBe(true);
  });

  it('returns false for a Pod', () => {
    expect(containsSecret({ kind: 'Pod', apiVersion: 'v1' })).toBe(false);
  });

  it('returns false for null and primitives', () => {
    expect(containsSecret(null)).toBe(false);
    expect(containsSecret(undefined)).toBe(false);
    expect(containsSecret(42)).toBe(false);
    expect(containsSecret('Secret')).toBe(false);
  });

  it('returns false for an array', () => {
    expect(containsSecret([{ kind: 'Secret' }])).toBe(false);
  });

  it('returns true for a List that contains a Secret', () => {
    expect(
      containsSecret({
        kind: 'List',
        items: [
          { kind: 'Pod' },
          { kind: 'Secret', data: {} },
        ],
      }),
    ).toBe(true);
  });

  it('returns false for a List with no Secrets', () => {
    expect(
      containsSecret({
        kind: 'List',
        items: [{ kind: 'Pod' }, { kind: 'ConfigMap' }],
      }),
    ).toBe(false);
  });

  it('returns true for a SecretList', () => {
    expect(
      containsSecret({
        kind: 'SecretList',
        items: [{ kind: 'Secret', data: {} }],
      }),
    ).toBe(true);
  });

  it('returns false for a List with a non-array items field', () => {
    expect(containsSecret({ kind: 'List', items: 'oops' })).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(containsSecret({})).toBe(false);
  });
});

// ── redactDataFields ──────────────────────────────────────────────────────────

describe('redactDataFields', () => {
  it('replaces each value with a <redacted: N bytes> placeholder', () => {
    const result = redactDataFields({ key: 'value' }, false);
    expect(result['key']).toMatch(/^<redacted: \d+ bytes>$/);
  });

  it('counts UTF-8 bytes for stringData (isBase64=false)', () => {
    // 'hello' = 5 ASCII bytes
    expect(redactDataFields({ key: 'hello' }, false)['key']).toBe('<redacted: 5 bytes>');
    // 3-byte UTF-8 char × 1 = 3 bytes
    expect(redactDataFields({ key: '€' }, false)['key']).toBe('<redacted: 3 bytes>');
  });

  it('estimates base64-decoded byte length for .data (isBase64=true)', () => {
    // "dGVzdA==" decodes to "test" = 4 bytes; floor((6 * 3) / 4) = 4
    expect(redactDataFields({ key: 'dGVzdA==' }, true)['key']).toBe('<redacted: 4 bytes>');
  });

  it('treats null and undefined as empty string (0 bytes); coerces other non-strings via String()', () => {
    const result = redactDataFields({ n: 42, nul: null, undef: undefined } as Record<string, unknown>, false);
    // null and undefined → String(null ?? '') = '' → 0 bytes
    expect(result['nul']).toBe('<redacted: 0 bytes>');
    expect(result['undef']).toBe('<redacted: 0 bytes>');
    // 42 → String(42) = '42' → 2 bytes
    expect(result['n']).toBe('<redacted: 2 bytes>');
  });

  it('preserves all keys', () => {
    const fields = { a: 'aaa', b: 'bbb', c: 'ccc' };
    const result = redactDataFields(fields, false);
    expect(Object.keys(result)).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty object for empty input', () => {
    expect(redactDataFields({}, false)).toEqual({});
  });

  it('base64 with no padding: floor((4 * 3) / 4) = 3 bytes', () => {
    // "dGVz" decodes to "tes" = 3 bytes; no padding chars to strip
    expect(redactDataFields({ key: 'dGVz' }, true)['key']).toBe('<redacted: 3 bytes>');
  });
});

// ── redactObject ──────────────────────────────────────────────────────────────

describe('redactObject', () => {
  it('redacts .data on a Secret', () => {
    const secret = { kind: 'Secret', data: { password: 'dGVzdA==' } };
    const result = redactObject(secret) as typeof secret;
    expect((result.data as Record<string, string>)['password']).toMatch(/^<redacted:/);
  });

  it('redacts .stringData on a Secret', () => {
    const secret = { kind: 'Secret', stringData: { token: 'my-token' } };
    const result = redactObject(secret) as typeof secret;
    expect((result.stringData as Record<string, string>)['token']).toMatch(/^<redacted:/);
  });

  it('passes through non-Secret objects unchanged', () => {
    const pod = { kind: 'Pod', spec: { containers: [] } };
    expect(redactObject(pod)).toBe(pod);
  });

  it('passes through null, undefined, and primitives unchanged', () => {
    expect(redactObject(null)).toBeNull();
    expect(redactObject(undefined)).toBeUndefined();
    expect(redactObject(42)).toBe(42);
    expect(redactObject('string')).toBe('string');
  });

  it('passes through arrays unchanged', () => {
    const arr = [{ kind: 'Secret', data: { key: 'val' } }];
    expect(redactObject(arr)).toBe(arr);
  });

  it('recursively redacts Secrets inside a List', () => {
    const list = {
      kind: 'List',
      items: [
        { kind: 'Secret', data: { key: 'dmFsdWU=' } },
        { kind: 'Pod', spec: {} },
      ],
    };
    const result = redactObject(list) as { kind: string; items: Array<Record<string, unknown>> };
    const secretItem = result.items[0] as { data: Record<string, string> };
    expect(secretItem.data['key']).toMatch(/^<redacted:/);
    // Pod passes through unchanged
    expect((result.items[1] as { kind: string }).kind).toBe('Pod');
  });

  it('recursively redacts Secrets inside a SecretList', () => {
    const list = {
      kind: 'SecretList',
      items: [
        { kind: 'Secret', data: { token: 'c2VjcmV0' } },
      ],
    };
    const result = redactObject(list) as { items: Array<{ data: Record<string, string> }> };
    expect(result.items[0].data['token']).toMatch(/^<redacted:/);
  });

  it('does not mutate the original object', () => {
    const secret = { kind: 'Secret', data: { key: 'val' } };
    const original = JSON.stringify(secret);
    redactObject(secret);
    expect(JSON.stringify(secret)).toBe(original);
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
