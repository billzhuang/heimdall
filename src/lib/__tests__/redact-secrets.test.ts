import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { redactSecretValues } from '../redact-secrets.ts';

const PLACEHOLDER_RE = /^<redacted: \d+ bytes>$/;

// ---------------------------------------------------------------------------
// Non-secret / non-JSON inputs — must be returned unchanged
// ---------------------------------------------------------------------------

describe('redactSecretValues: passthrough cases', () => {
  it('returns non-JSON text unchanged', () => {
    const text = 'NAME\nweb-1  Running\n';
    expect(redactSecretValues(text)).toBe(text);
  });

  it('returns empty string unchanged', () => {
    expect(redactSecretValues('')).toBe('');
  });

  it('returns non-Secret JSON unchanged and without re-serialisation', () => {
    const pod = JSON.stringify({ kind: 'Pod', metadata: { name: 'web' }, data: { not: 'a-secret' } });
    expect(redactSecretValues(pod)).toBe(pod);
  });

  it('returns ConfigMap JSON unchanged', () => {
    const cm = JSON.stringify({ kind: 'ConfigMap', data: { key: 'value' } });
    expect(redactSecretValues(cm)).toBe(cm);
  });

  it('returns Secret with no data/stringData without modification', () => {
    const secret = JSON.stringify({ kind: 'Secret', metadata: { name: 'empty' } });
    const result = redactSecretValues(secret);
    const parsed = JSON.parse(result);
    expect(parsed.kind).toBe('Secret');
    // No data → original returned unchanged
    expect(result).toBe(secret);
  });

  it('returns Secret with empty data object unchanged', () => {
    const secret = JSON.stringify({ kind: 'Secret', data: {} });
    expect(redactSecretValues(secret)).toBe(secret);
  });
});

// ---------------------------------------------------------------------------
// Secret redaction — JSON
// ---------------------------------------------------------------------------

describe('redactSecretValues: Secret JSON', () => {
  const rawData = {
    password: Buffer.from('supersecret').toString('base64'),
    username: Buffer.from('admin').toString('base64'),
  };
  const secretJson = JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'db-creds', namespace: 'prod' },
    type: 'Opaque',
    data: rawData,
    stringData: { dsn: 'postgres://admin:supersecret@db:5432/app' },
  });

  it('replaces .data values with redacted placeholders', () => {
    const result = JSON.parse(redactSecretValues(secretJson));
    expect(result.data.password).toMatch(PLACEHOLDER_RE);
    expect(result.data.username).toMatch(PLACEHOLDER_RE);
  });

  it('replaces .stringData values with redacted placeholders', () => {
    const result = JSON.parse(redactSecretValues(secretJson));
    expect(result.stringData.dsn).toMatch(PLACEHOLDER_RE);
  });

  it('reports correct decoded byte count for .data (base64)', () => {
    // 'hello' is 5 bytes
    const s = JSON.stringify({ kind: 'Secret', data: { key: Buffer.from('hello').toString('base64') } });
    const result = JSON.parse(redactSecretValues(s));
    expect(result.data.key).toBe('<redacted: 5 bytes>');
  });

  it('reports correct byte count for .stringData (UTF-8)', () => {
    const s = JSON.stringify({ kind: 'Secret', stringData: { token: 'abc' } });
    const result = JSON.parse(redactSecretValues(s));
    expect(result.stringData.token).toBe('<redacted: 3 bytes>');
  });

  it('preserves metadata, kind, apiVersion, and type fields', () => {
    const result = JSON.parse(redactSecretValues(secretJson));
    expect(result.kind).toBe('Secret');
    expect(result.apiVersion).toBe('v1');
    expect(result.metadata.name).toBe('db-creds');
    expect(result.metadata.namespace).toBe('prod');
    expect(result.type).toBe('Opaque');
  });

  it('original secret values are absent from the redacted output string', () => {
    const output = redactSecretValues(secretJson);
    expect(output).not.toContain('supersecret');
    expect(output).not.toContain(rawData.password);
    expect(output).not.toContain(rawData.username);
  });

  it('produces valid JSON', () => {
    expect(() => JSON.parse(redactSecretValues(secretJson))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SecretList and mixed List — JSON
// ---------------------------------------------------------------------------

describe('redactSecretValues: SecretList and List JSON', () => {
  it('redacts all items in a SecretList', () => {
    const list = {
      kind: 'SecretList',
      items: [
        { kind: 'Secret', data: { a: Buffer.from('val1').toString('base64') } },
        { kind: 'Secret', data: { b: Buffer.from('val2').toString('base64') } },
      ],
    };
    const result = JSON.parse(redactSecretValues(JSON.stringify(list)));
    expect(result.items[0].data.a).toMatch(PLACEHOLDER_RE);
    expect(result.items[1].data.b).toMatch(PLACEHOLDER_RE);
  });

  it('redacts only Secret items in a mixed List, leaving others unchanged', () => {
    const list = {
      kind: 'List',
      items: [
        { kind: 'ConfigMap', data: { config: 'value' } },
        { kind: 'Secret', data: { pass: Buffer.from('secret').toString('base64') } },
        { kind: 'Pod', spec: { containers: [] } },
      ],
    };
    const result = JSON.parse(redactSecretValues(JSON.stringify(list)));
    expect(result.items[0].data.config).toBe('value'); // ConfigMap untouched
    expect(result.items[1].data.pass).toMatch(PLACEHOLDER_RE); // Secret redacted
    expect(result.items[2].spec.containers).toEqual([]); // Pod untouched
  });

  it('returns a non-Secret List unchanged', () => {
    const list = JSON.stringify({ kind: 'List', items: [{ kind: 'Pod' }, { kind: 'Service' }] });
    expect(redactSecretValues(list)).toBe(list);
  });
});

// ---------------------------------------------------------------------------
// YAML format
// ---------------------------------------------------------------------------

describe('redactSecretValues: YAML format', () => {
  const yamlSecret = [
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    '  name: my-secret',
    'data:',
    `  token: ${Buffer.from('mysecrettoken').toString('base64')}`,
  ].join('\n');

  it('redacts .data values in YAML Secret output', () => {
    const result = redactSecretValues(yamlSecret, 'yaml');
    expect(result).not.toContain(Buffer.from('mysecrettoken').toString('base64'));
    expect(result).toContain('<redacted:');
  });

  it('returns non-YAML text unchanged', () => {
    const text = 'not: valid: yaml: ::';
    // yaml.load might still parse this — just confirm no throw
    expect(() => redactSecretValues(text, 'yaml')).not.toThrow();
  });

  it('returns YAML non-Secret unchanged', () => {
    const yamlPod = 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: web\n';
    expect(redactSecretValues(yamlPod, 'yaml')).toBe(yamlPod);
  });
});

// ---------------------------------------------------------------------------
// Property-based: no base64 data value survives redaction
// ---------------------------------------------------------------------------

describe('redactSecretValues: property tests', () => {
  it('property: no .data value from a Secret passes through after redaction', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_.-]*$/).filter((k) => k.length <= 32),
        (rawValue, keyName) => {
          const b64Value = Buffer.from(rawValue, 'utf8').toString('base64');
          const secretObj = { kind: 'Secret', data: { [keyName]: b64Value } };
          const input = JSON.stringify(secretObj);
          const output = redactSecretValues(input);
          const reparsed = JSON.parse(output) as { data: Record<string, string> };
          return reparsed.data[keyName] !== b64Value;
        },
      ),
    );
  });

  it('property: no .stringData value from a Secret passes through after redaction', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_.-]*$/).filter((k) => k.length <= 32),
        (rawValue, keyName) => {
          const secretObj = { kind: 'Secret', stringData: { [keyName]: rawValue } };
          const input = JSON.stringify(secretObj);
          const output = redactSecretValues(input);
          const reparsed = JSON.parse(output) as { stringData: Record<string, string> };
          return reparsed.stringData[keyName] !== rawValue;
        },
      ),
    );
  });

  it('property: non-Secret JSON is always returned unchanged', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('Pod', 'Deployment', 'ConfigMap', 'Service', 'Namespace'),
        fc.string({ maxLength: 32 }),
        (kind, name) => {
          const obj = JSON.stringify({ kind, metadata: { name }, data: { key: name } });
          return redactSecretValues(obj) === obj;
        },
      ),
    );
  });
});
