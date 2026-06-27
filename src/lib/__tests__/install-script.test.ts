import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const INSTALL_SCRIPT = resolve(REPO_ROOT, 'install.sh');

describe('install.sh', () => {
  it('exists at the repository root', () => {
    expect(existsSync(INSTALL_SCRIPT)).toBe(true);
  });

  it('is executable', () => {
    const mode = statSync(INSTALL_SCRIPT).mode;
    // Check owner execute bit (0o100)
    expect(mode & 0o100).toBeGreaterThan(0);
  });

  it('has valid bash syntax', () => {
    const result = spawnSync('bash', ['-n', INSTALL_SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  describe('script content', () => {
    let script: string;
    beforeAll(() => {
      script = readFileSync(INSTALL_SCRIPT, 'utf8');
    });

    it('uses set -euo pipefail for safety', () => {
      expect(script).toContain('set -euo pipefail');
    });

    it('checks Node.js minimum version', () => {
      expect(script).toContain('MIN_NODE_MAJOR=22');
      expect(script).toContain('MIN_NODE_MINOR=19');
    });

    it('validates Node.js is installed before proceeding', () => {
      expect(script).toContain('check_node');
      expect(script).toMatch(/command -v node/);
    });

    it('validates git is installed', () => {
      expect(script).toContain('check_git');
      expect(script).toMatch(/command -v git/);
    });

    it('validates npm is installed', () => {
      expect(script).toContain('check_npm');
      expect(script).toMatch(/command -v npm/);
    });

    it('warns (does not fail) when kubectl is missing', () => {
      // check_kubectl should call `warn` not `die` when kubectl is absent.
      // Match function body: from `check_kubectl()` up to the first blank line after a closing `}`.
      const fn = script.match(/check_kubectl\(\) \{[\s\S]+?\n\}/)?.[0] ?? '';
      expect(fn).toContain('warn');
      expect(fn).not.toMatch(/die .+kubectl/);
    });

    it('supports --upgrade flag to update existing installations', () => {
      expect(script).toContain('--upgrade');
      expect(script).toContain('UPGRADE=true');
    });

    it('supports --dir flag to override install directory', () => {
      expect(script).toContain('--dir');
      expect(script).toContain('INSTALL_DIR');
    });

    it('supports --bin flag to override binary directory', () => {
      expect(script).toContain('--bin');
      expect(script).toContain('BIN_DIR');
    });

    it('builds Heimdall after installing deps', () => {
      // The script uses `npm --prefix $INSTALL_DIR run build` to build in place.
      expect(script).toMatch(/npm\b.*run build/);
    });

    it('creates a symlink in the bin directory', () => {
      expect(script).toContain('ln -s');
    });

    it('respects HEIMDALL_DIR env var for install directory', () => {
      expect(script).toContain('HEIMDALL_DIR');
    });

    it('respects HEIMDALL_BIN_DIR env var for binary directory', () => {
      expect(script).toContain('HEIMDALL_BIN_DIR');
    });

    it('patches shell rc file with PATH when bin dir is not on PATH', () => {
      expect(script).toContain('patch_path');
      expect(script).toMatch(/\.zshrc|\.bashrc|\.profile/);
    });

    it('supports fish shell in PATH patching', () => {
      expect(script).toContain('fish');
      expect(script).toContain('fish_add_path');
    });

    it('uses --depth=1 for shallow clone (fast download)', () => {
      expect(script).toContain('--depth=1');
    });

    it('uses --omit=dev to skip dev dependencies in production', () => {
      expect(script).toContain('--omit=dev');
    });

    it('clones from the correct GitHub repository', () => {
      expect(script).toContain('github.com/billzhuang/heimdall');
    });

    it('prints a help message with --help', () => {
      expect(script).toContain('--help');
      expect(script).toContain('-h');
    });
  });

  describe('--help flag', () => {
    it('exits 0 and prints usage when --help is passed', () => {
      const result = spawnSync('bash', [INSTALL_SCRIPT, '--help'], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/install/i);
    });
  });

  describe('error handling', () => {
    it('exits non-zero for unknown arguments', () => {
      const result = spawnSync('bash', [INSTALL_SCRIPT, '--unknown-flag'], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Unknown argument/i);
    });

    it('exits non-zero when --dir is missing its argument', () => {
      const result = spawnSync('bash', [INSTALL_SCRIPT, '--dir'], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
    });
  });
});
