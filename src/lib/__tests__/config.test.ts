import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../config.ts';

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
    expect(config.tools).toEqual({ kubectl: true, listContexts: true, listNamespaces: true, helmRelease: true, prometheusQuery: false, awsCli: false, trivyScan: false, kubecostQuery: false, lokiQuery: false });
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
    expect(config.tools).toEqual({ kubectl: true, listContexts: true, listNamespaces: true, helmRelease: true, prometheusQuery: false, awsCli: false, trivyScan: false, kubecostQuery: false, lokiQuery: false });
  });

  it('returns defaults when the YAML is malformed', () => {
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, ': bad yaml: [\n');
    const config = loadConfig(configPath);
    expect(config.tools).toEqual({ kubectl: true, listContexts: true, listNamespaces: true, helmRelease: true, prometheusQuery: false, awsCli: false, trivyScan: false, kubecostQuery: false, lokiQuery: false });
  });

  it('returns defaults when the config fails schema validation', () => {
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, `tools:\n  kubectl: "yes"\n`); // string instead of boolean
    const config = loadConfig(configPath);
    expect(config.tools).toEqual({ kubectl: true, listContexts: true, listNamespaces: true, helmRelease: true, prometheusQuery: false, awsCli: false, trivyScan: false, kubecostQuery: false, lokiQuery: false });
  });

  it('enables all tools when the tools section is omitted', () => {
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, '# no tools key\n');
    const config = loadConfig(configPath);
    expect(config.tools).toEqual({ kubectl: true, listContexts: true, listNamespaces: true, helmRelease: true, prometheusQuery: false, awsCli: false, trivyScan: false, kubecostQuery: false, lokiQuery: false });
  });

  it('handles null tools block (empty YAML key like `tools:`) gracefully', () => {
    // js-yaml parses `tools:` with no value as null, not undefined.
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, 'tools:\n');
    const config = loadConfig(configPath);
    expect(config.tools).toEqual({ kubectl: true, listContexts: true, listNamespaces: true, helmRelease: true, prometheusQuery: false, awsCli: false, trivyScan: false, kubecostQuery: false, lokiQuery: false });
  });

  it('returns defaults and warns when config is a scalar (not a mapping)', () => {
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, 'true\n');
    const config = loadConfig(configPath);
    expect(config.tools).toEqual({ kubectl: true, listContexts: true, listNamespaces: true, helmRelease: true, prometheusQuery: false, awsCli: false, trivyScan: false, kubecostQuery: false, lokiQuery: false });
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
});
