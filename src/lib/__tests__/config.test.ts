import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
});
