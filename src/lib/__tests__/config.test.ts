import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../config.ts';

const EXPECTED_DEFAULT_TOOLS = {
  kubectl: true,
  listContexts: true,
  listNamespaces: true,
  helmRelease: true,
  prometheusQuery: false,
  awsCli: false,
  trivyScan: false,
  kubecostQuery: false,
  lokiQuery: false,
  jaegerQuery: false,
  datadogQuery: false,
  newRelicQuery: false,
  cdkQuery: false,
} as const;

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `heimdall-config-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns all-enabled defaults when no config file exists', () => {
    const config = loadConfig(join(tmpDir, 'nonexistent.yaml'));
    expect(config.tools).toEqual(EXPECTED_DEFAULT_TOOLS);
  });

  it('defaults audit to disabled when no audit section is present', () => {
    const config = loadConfig(join(tmpDir, 'nonexistent.yaml'));
    expect(config.audit?.enabled).toBe(false);
  });

  it('loads audit config with enabled and file', () => {
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, `tools:\n  kubectl: true\naudit:\n  enabled: true\n  file: /var/log/audit.jsonl\n`);
    const config = loadConfig(configPath);
    expect(config.audit?.enabled).toBe(true);
    expect(config.audit?.file).toBe('/var/log/audit.jsonl');
  });

  it('defaults audit.file to null/undefined (stderr) when omitted', () => {
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, `audit:\n  enabled: true\n`);
    const config = loadConfig(configPath);
    expect(config.audit?.enabled).toBe(true);
    expect(config.audit?.file ?? null).toBeNull();
  });

  it('loads a valid config file and respects disabled tools', () => {
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(
      configPath,
      `tools:\n  kubectl: true\n  listContexts: false\n  listNamespaces: false\n`,
    );
    const config = loadConfig(configPath);
    expect(config.tools.kubectl).toBe(true);
    expect(config.tools.listContexts).toBe(false);
    expect(config.tools.listNamespaces).toBe(false);
  });

  it('fills in missing tool keys with their defaults (most true, prometheusQuery false)', () => {
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, `tools:\n  kubectl: false\n`);
    const config = loadConfig(configPath);
    expect(config.tools.kubectl).toBe(false);
    expect(config.tools.listContexts).toBe(true);
    expect(config.tools.listNamespaces).toBe(true);
    expect(config.tools.prometheusQuery).toBe(false);
  });

  it('returns defaults for an empty config file', () => {
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, '');
    const config = loadConfig(configPath);
    expect(config.tools).toEqual(EXPECTED_DEFAULT_TOOLS);
  });

  it('returns defaults when the YAML is malformed', () => {
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, ': bad yaml: [\n');
    const config = loadConfig(configPath);
    expect(config.tools).toEqual(EXPECTED_DEFAULT_TOOLS);
  });

  it('returns defaults when the config fails schema validation', () => {
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, `tools:\n  kubectl: "yes"\n`); // string instead of boolean
    const config = loadConfig(configPath);
    expect(config.tools).toEqual(EXPECTED_DEFAULT_TOOLS);
  });

  it('enables all tools when the tools section is omitted', () => {
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, '# no tools key\n');
    const config = loadConfig(configPath);
    expect(config.tools).toEqual(EXPECTED_DEFAULT_TOOLS);
  });

  it('handles null tools block (empty YAML key like `tools:`) gracefully', () => {
    // js-yaml parses `tools:` with no value as null, not undefined.
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, 'tools:\n');
    const config = loadConfig(configPath);
    expect(config.tools).toEqual(EXPECTED_DEFAULT_TOOLS);
  });

  it('returns defaults and warns when config is a scalar (not a mapping)', () => {
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, 'true\n');
    const config = loadConfig(configPath);
    expect(config.tools).toEqual(EXPECTED_DEFAULT_TOOLS);
  });

  it('each call returns an independent object (no shared mutable default)', () => {
    const config1 = loadConfig(join(tmpDir, 'nonexistent.yaml'));
    const config2 = loadConfig(join(tmpDir, 'nonexistent.yaml'));
    expect(config1.tools).not.toBe(config2.tools);
  });

  describe('snake_case aliases', () => {
    it('accepts list_contexts as an alias for listContexts (actually works, not just warned)', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `tools:\n  list_contexts: false\n`);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = loadConfig(configPath);
      expect(config.tools.listContexts).toBe(false);
      expect(config.tools.kubectl).toBe(true);
      expect(config.tools.listNamespaces).toBe(true);
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('unknown tools key'));
      warnSpy.mockRestore();
    });

    it('accepts list_namespaces as an alias for listNamespaces', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `tools:\n  list_namespaces: false\n`);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = loadConfig(configPath);
      expect(config.tools.listNamespaces).toBe(false);
      expect(config.tools.kubectl).toBe(true);
      expect(config.tools.listContexts).toBe(true);
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('unknown tools key'));
      warnSpy.mockRestore();
    });

    it('accepts mixed camelCase and snake_case in the same block', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `tools:\n  kubectl: false\n  list_contexts: false\n  listNamespaces: false\n`);
      const config = loadConfig(configPath);
      expect(config.tools.kubectl).toBe(false);
      expect(config.tools.listContexts).toBe(false);
      expect(config.tools.listNamespaces).toBe(false);
    });

    it('accepts helm_release as an alias for helmRelease', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `tools:\n  helm_release: false\n`);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = loadConfig(configPath);
      expect(config.tools.helmRelease).toBe(false);
      expect(config.tools.kubectl).toBe(true);
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('unknown tools key'));
      warnSpy.mockRestore();
    });
  });

  describe('unknown tools key warnings', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('warns for a completely unknown tools key', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `tools:\n  kubectl: true\n  bogusKey: false\n`);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      loadConfig(configPath);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"bogusKey"'));
      warnSpy.mockRestore();
    });

    it('does not warn for valid camelCase tool keys', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `tools:\n  kubectl: true\n  listContexts: false\n  listNamespaces: false\n`);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      loadConfig(configPath);
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('unknown tools key'));
    });

    it('does not warn for snake_case alias keys', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `tools:\n  list_contexts: false\n  list_namespaces: false\n`);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      loadConfig(configPath);
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('unknown tools key'));
      warnSpy.mockRestore();
    });

    it('does not warn when tools section is absent', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, '# no tools\n');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      loadConfig(configPath);
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('unknown tools key'));
    });

    it('does not warn when tools block is an array (malformed config)', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, 'tools:\n  - kubectl\n');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      loadConfig(configPath);
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('unknown tools key'));
    });

    it('ignores unknown keys for config output but still processes known keys', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `tools:\n  kubectl: false\n  typo_key: true\n`);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = loadConfig(configPath);
      expect(config.tools.kubectl).toBe(false);
      expect(config.tools.listContexts).toBe(true);
      expect(config.tools.listNamespaces).toBe(true);
      warnSpy.mockRestore();
    });

    it('accepts prometheus_query as an alias for prometheusQuery', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `tools:\n  prometheus_query: true\n`);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = loadConfig(configPath);
      expect(config.tools.prometheusQuery).toBe(true);
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('unknown tools key'));
      warnSpy.mockRestore();
    });
  });

  describe('learning config block', () => {
    it('defaults learning.enabled to true when not present', () => {
      const config = loadConfig(join(tmpDir, 'nonexistent.yaml'));
      expect(config.learning?.enabled).toBe(true);
    });

    it('loads learning.file from config', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `learning:\n  file: /mnt/efs/task-history.jsonl\n`);
      const config = loadConfig(configPath);
      expect(config.learning?.file).toBe('/mnt/efs/task-history.jsonl');
    });

    it('loads learning.logFile from config', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `learning:\n  logFile: /mnt/efs/learning-log.jsonl\n`);
      const config = loadConfig(configPath);
      expect(config.learning?.logFile).toBe('/mnt/efs/learning-log.jsonl');
    });

    it('learning.logFile defaults to undefined when not set', () => {
      const config = loadConfig(join(tmpDir, 'nonexistent.yaml'));
      expect(config.learning?.logFile ?? null).toBeNull();
    });

    it('accepts both learning.file and learning.logFile together', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(
        configPath,
        `learning:\n  file: /mnt/efs/task-history.jsonl\n  logFile: /mnt/efs/learning-log.jsonl\n`,
      );
      const config = loadConfig(configPath);
      expect(config.learning?.file).toBe('/mnt/efs/task-history.jsonl');
      expect(config.learning?.logFile).toBe('/mnt/efs/learning-log.jsonl');
    });
  });

  describe('prometheus config block', () => {
    it('defaults prometheus to undefined when not present', () => {
      const config = loadConfig(join(tmpDir, 'nonexistent.yaml'));
      expect(config.prometheus).toBeUndefined();
    });

    it('loads prometheus url and timeoutMs', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `prometheus:\n  url: http://prom:9090\n  timeoutMs: 5000\n`);
      const config = loadConfig(configPath);
      expect(config.prometheus?.url).toBe('http://prom:9090');
      expect(config.prometheus?.timeoutMs).toBe(5000);
    });

    it('defaults prometheusQuery tool to false even when prometheus block is present', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `prometheus:\n  url: http://prom:9090\n`);
      const config = loadConfig(configPath);
      expect(config.tools.prometheusQuery).toBe(false);
    });

    it('allows enabling prometheusQuery independently of prometheus block', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `tools:\n  prometheusQuery: true\n`);
      const config = loadConfig(configPath);
      expect(config.tools.prometheusQuery).toBe(true);
    });
  });

  describe('kubecost config block', () => {
    it('defaults kubecost to undefined when not present', () => {
      const config = loadConfig(join(tmpDir, 'nonexistent.yaml'));
      expect(config.kubecost).toBeUndefined();
    });

    it('loads kubecost url and timeoutMs', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `kubecost:\n  url: http://kubecost:9090\n  timeoutMs: 5000\n`);
      const config = loadConfig(configPath);
      expect(config.kubecost?.url).toBe('http://kubecost:9090');
      expect(config.kubecost?.timeoutMs).toBe(5000);
    });

    it('defaults timeoutMs to 10000 when kubecost block is present but timeoutMs is omitted', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `kubecost:\n  url: http://kubecost:9090\n`);
      const config = loadConfig(configPath);
      expect(config.kubecost?.timeoutMs).toBe(10_000);
    });

    it('defaults kubecostQuery tool to false even when kubecost block is present', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `kubecost:\n  url: http://kubecost:9090\n`);
      const config = loadConfig(configPath);
      expect(config.tools.kubecostQuery).toBe(false);
    });

    it('allows enabling kubecostQuery independently of kubecost block', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `tools:\n  kubecostQuery: true\n`);
      const config = loadConfig(configPath);
      expect(config.tools.kubecostQuery).toBe(true);
    });

    it('accepts kubecost_query as a snake_case alias for kubecostQuery', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `tools:\n  kubecost_query: true\n`);
      const config = loadConfig(configPath);
      expect(config.tools.kubecostQuery).toBe(true);
    });
  });

  describe('newRelic config block', () => {
    it('coerces numeric accountId to string so bare YAML integers are accepted', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `newRelic:\n  apiKey: test-key\n  accountId: 1234567\n`);
      const config = loadConfig(configPath);
      expect(config.newRelic?.accountId).toBe('1234567');
    });

    it('accepts string accountId unchanged', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `newRelic:\n  apiKey: test-key\n  accountId: "1234567"\n`);
      const config = loadConfig(configPath);
      expect(config.newRelic?.accountId).toBe('1234567');
    });

    it('defaults newRelicQuery tool to false even when newRelic block is present', () => {
      const configPath = join(tmpDir, 'heimdall.config.yaml');
      writeFileSync(configPath, `newRelic:\n  apiKey: test-key\n  accountId: "1234567"\n`);
      const config = loadConfig(configPath);
      expect(config.tools.newRelicQuery).toBe(false);
    });
  });

  describe('HEIMDALL_CONFIG_YAML env var', () => {
    afterEach(() => {
      delete process.env.HEIMDALL_CONFIG_YAML;
    });

    it('loads config from raw YAML string when HEIMDALL_CONFIG_YAML is set', () => {
      process.env.HEIMDALL_CONFIG_YAML = [
        'tools:',
        '  kubectl: false',
        '  prometheusQuery: true',
        'prometheus:',
        '  url: "https://prometheus.example.com"',
      ].join('\n');
      const config = loadConfig();
      expect(config.tools.kubectl).toBe(false);
      expect(config.tools.prometheusQuery).toBe(true);
      expect(config.prometheus?.url).toBe('https://prometheus.example.com');
    });

    it('explicit configPath argument takes priority over HEIMDALL_CONFIG_YAML', () => {
      process.env.HEIMDALL_CONFIG_YAML = 'tools:\n  kubectl: false\n';
      const configPath = join(tmpDir, 'override.yaml');
      writeFileSync(configPath, 'tools:\n  kubectl: true\n  prometheusQuery: true\n');
      const config = loadConfig(configPath);
      // File overrides env var.
      expect(config.tools.kubectl).toBe(true);
      expect(config.tools.prometheusQuery).toBe(true);
    });

    it('returns defaults when HEIMDALL_CONFIG_YAML contains invalid YAML', () => {
      process.env.HEIMDALL_CONFIG_YAML = ': bad: yaml: [unclosed';
      const config = loadConfig();
      expect(config.tools).toEqual(EXPECTED_DEFAULT_TOOLS);
    });

    it('returns defaults when HEIMDALL_CONFIG_YAML is a scalar not a mapping', () => {
      process.env.HEIMDALL_CONFIG_YAML = 'just a string';
      const config = loadConfig();
      expect(config.tools).toEqual(EXPECTED_DEFAULT_TOOLS);
    });
  });

  describe('Cloudflare Workers config', () => {
    it('disables all subprocess tools and leaves HTTP tools configurable', () => {
      const configPath = join(tmpDir, 'heimdall.config.cloudflare.yaml');
      writeFileSync(
        configPath,
        [
          'tools:',
          '  kubectl: false',
          '  listContexts: false',
          '  listNamespaces: false',
          '  helmRelease: false',
          '  awsCli: false',
          '  trivyScan: false',
          '  cdkQuery: false',
          '  prometheusQuery: true',
          '  lokiQuery: true',
          '  jaegerQuery: false',
          '  datadogQuery: false',
          '  newRelicQuery: false',
          '  kubecostQuery: false',
        ].join('\n'),
      );
      const config = loadConfig(configPath);
      expect(config.tools.kubectl).toBe(false);
      expect(config.tools.listContexts).toBe(false);
      expect(config.tools.listNamespaces).toBe(false);
      expect(config.tools.helmRelease).toBe(false);
      expect(config.tools.awsCli).toBe(false);
      expect(config.tools.trivyScan).toBe(false);
      expect(config.tools.cdkQuery).toBe(false);
      expect(config.tools.prometheusQuery).toBe(true);
      expect(config.tools.lokiQuery).toBe(true);
    });

    it('accepts a cloudflare config with prometheus and loki URLs', () => {
      const configPath = join(tmpDir, 'heimdall.config.cloudflare.yaml');
      writeFileSync(
        configPath,
        [
          'tools:',
          '  kubectl: false',
          '  prometheusQuery: true',
          '  lokiQuery: true',
          'prometheus:',
          '  url: "https://prometheus.example.com"',
          '  timeoutMs: 10000',
          'loki:',
          '  url: "https://loki.example.com"',
          '  timeoutMs: 15000',
        ].join('\n'),
      );
      const config = loadConfig(configPath);
      expect(config.tools.kubectl).toBe(false);
      expect(config.tools.prometheusQuery).toBe(true);
      expect(config.tools.lokiQuery).toBe(true);
      expect(config.prometheus?.url).toBe('https://prometheus.example.com');
      expect(config.loki?.url).toBe('https://loki.example.com');
    });

    it('explicitly disabling subprocess tools in config is the required safe pattern for Cloudflare', () => {
      const configPath = join(tmpDir, 'heimdall.config.cloudflare.yaml');
      // Minimal config disabling only subprocess tools; HTTP tools remain at defaults.
      writeFileSync(
        configPath,
        [
          'tools:',
          '  kubectl: false',
          '  listContexts: false',
          '  listNamespaces: false',
          '  helmRelease: false',
          '  awsCli: false',
          '  trivyScan: false',
          '  cdkQuery: false',
        ].join('\n'),
      );
      const config = loadConfig(configPath);
      // Subprocess tools are explicitly disabled.
      expect(config.tools.kubectl).toBe(false);
      expect(config.tools.awsCli).toBe(false);
      expect(config.tools.trivyScan).toBe(false);
      expect(config.tools.cdkQuery).toBe(false);
      // HTTP tools remain at their schema defaults (false unless explicitly enabled).
      expect(config.tools.prometheusQuery).toBe(false);
      expect(config.tools.datadogQuery).toBe(false);
    });
  });
});
