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
    expect(config.tools).toEqual({ kubectl: true, listContexts: true, listNamespaces: true });
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

  it('fills in missing tool keys with true', () => {
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, `tools:\n  kubectl: false\n`);
    const config = loadConfig(configPath);
    expect(config.tools.kubectl).toBe(false);
    expect(config.tools.listContexts).toBe(true);
    expect(config.tools.listNamespaces).toBe(true);
  });

  it('returns defaults for an empty config file', () => {
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, '');
    const config = loadConfig(configPath);
    expect(config.tools).toEqual({ kubectl: true, listContexts: true, listNamespaces: true });
  });

  it('returns defaults when the YAML is malformed', () => {
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, ': bad yaml: [\n');
    const config = loadConfig(configPath);
    expect(config.tools).toEqual({ kubectl: true, listContexts: true, listNamespaces: true });
  });

  it('returns defaults when the config fails schema validation', () => {
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, `tools:\n  kubectl: "yes"\n`); // string instead of boolean
    const config = loadConfig(configPath);
    expect(config.tools).toEqual({ kubectl: true, listContexts: true, listNamespaces: true });
  });

  it('enables all tools when the tools section is omitted', () => {
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, '# no tools key\n');
    const config = loadConfig(configPath);
    expect(config.tools).toEqual({ kubectl: true, listContexts: true, listNamespaces: true });
  });

  it('handles null tools block (empty YAML key like `tools:`) gracefully', () => {
    // js-yaml parses `tools:` with no value as null, not undefined.
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, 'tools:\n');
    const config = loadConfig(configPath);
    expect(config.tools).toEqual({ kubectl: true, listContexts: true, listNamespaces: true });
  });

  it('returns defaults and warns when config is a scalar (not a mapping)', () => {
    const configPath = join(tmpDir, 'heimdall.config.yaml');
    writeFileSync(configPath, 'true\n');
    const config = loadConfig(configPath);
    expect(config.tools).toEqual({ kubectl: true, listContexts: true, listNamespaces: true });
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
  });
});
