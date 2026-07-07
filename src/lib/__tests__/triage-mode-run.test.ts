/**
 * Characterization tests for runTriageMode's orchestration logic: drift
 * detection (load/capture/save/prompt-injection) and baseline recording.
 * These pin current behavior ahead of a code-motion refactor that extracts
 * the two concerns into named helpers with no logic change.
 *
 * The agent subprocess (spawn) and kubectl are mocked; drift.ts and
 * baseline.ts run for real against temp files so the JSONL read/write paths
 * are exercised too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../config.ts', () => ({ loadConfig: vi.fn(), resolveConfigDir: () => '/tmp' }));
vi.mock('../kubectl.ts', () => ({ runKubectl: vi.fn() }));
// saveCheckpoint runs real (writes to a temp file below) but is spied on so
// tests can await its fire-and-forget call from runTriageMode, which does
// not await it itself — without this, checkpoint-file assertions race the write.
vi.mock('../drift.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../drift.ts')>();
  return { ...original, saveCheckpoint: vi.fn(original.saveCheckpoint) };
});

import { spawn } from 'node:child_process';
import { loadConfig } from '../config.ts';
import { runKubectl } from '../kubectl.ts';
import { saveCheckpoint } from '../drift.ts';
import { runTriageMode } from '../../triage-mode.ts';

/** Await runTriageMode and, if it triggered a checkpoint save, the save itself. */
async function runTriageModeSettled(opts: Parameters<typeof runTriageMode>[0] = {}): Promise<void> {
  await runTriageMode(opts);
  const calls = vi.mocked(saveCheckpoint).mock.results;
  await calls[calls.length - 1]?.value?.catch(() => {});
}

type FakeChildOptions = {
  stdoutData?: string;
  exitCode?: number | null;
};

function fakeChild({ stdoutData = 'Triage report\n', exitCode = 0 }: FakeChildOptions = {}) {
  const childEmitter = new EventEmitter();
  const stdout = new EventEmitter();
  setImmediate(() => {
    if (stdoutData) stdout.emit('data', Buffer.from(stdoutData));
    childEmitter.emit('close', exitCode, null);
  });
  return Object.assign(childEmitter, { stdout, stderr: new EventEmitter() });
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    tools: { prometheusQuery: false },
    slos: [],
    ...overrides,
  };
}

describe('runTriageMode', () => {
  let dir: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'heimdall-triage-mode-'));
    // mockImplementation (not mockReturnValue) so a fresh child — and its
    // setImmediate emission — is created at the moment spawn() is actually
    // called, after listeners are attached. A pre-built instance would fire
    // its events before runAgent's `.on()` calls ever run, hanging the test.
    vi.mocked(spawn).mockImplementation(() => fakeChild() as unknown as ReturnType<typeof spawn>);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function promptArg(): string {
    const call = vi.mocked(spawn).mock.calls[0];
    const args = call[1] as string[];
    return args[1];
  }

  it('skips drift detection and baseline writes when both are disabled', async () => {
    vi.mocked(loadConfig).mockReturnValue(baseConfig({ learning: { enabled: false } }) as never);

    await runTriageMode({});

    expect(runKubectl).not.toHaveBeenCalled();
    expect(promptArg()).not.toContain('Infrastructure Drift');
  });

  it('captures and saves a checkpoint but injects no drift section when there is no previous baseline', async () => {
    const checkpointFile = join(dir, 'checkpoint.jsonl');
    vi.mocked(loadConfig).mockReturnValue(
      baseConfig({ drift: { enabled: true, checkpointFile }, learning: { enabled: false } }) as never,
    );
    vi.mocked(runKubectl).mockImplementation(async (args: string) => {
      if (args.startsWith('get namespaces')) return JSON.stringify({ items: [{ metadata: { name: 'default' } }] });
      if (args.startsWith('get nodes')) return JSON.stringify({ items: [] });
      return JSON.stringify({ items: [] });
    });

    await runTriageModeSettled();

    expect(promptArg()).not.toContain('Infrastructure Drift');
    const saved = JSON.parse((await readFile(checkpointFile, 'utf8')).trim());
    expect(saved.namespaces).toEqual(['default']);
    expect(stderrSpy.mock.calls.map((c: unknown[]) => c[0]).join('')).toContain('No previous checkpoint found');
  });

  it('injects a drift section and reports the change count when the cluster state differs from the checkpoint', async () => {
    const checkpointFile = join(dir, 'checkpoint.jsonl');
    vi.mocked(loadConfig).mockReturnValue(
      baseConfig({ drift: { enabled: true, checkpointFile }, learning: { enabled: false } }) as never,
    );

    // Seed a previous checkpoint with namespace "default" only.
    vi.mocked(runKubectl).mockImplementation(async (args: string) => {
      if (args.startsWith('get namespaces')) return JSON.stringify({ items: [{ metadata: { name: 'default' } }] });
      return JSON.stringify({ items: [] });
    });
    await runTriageModeSettled();
    vi.mocked(spawn).mockClear();
    (stderrSpy.mock.calls as unknown[][]).length = 0;

    // Second run: a new namespace "prod" has appeared.
    vi.mocked(runKubectl).mockImplementation(async (args: string) => {
      if (args.startsWith('get namespaces')) {
        return JSON.stringify({ items: [{ metadata: { name: 'default' } }, { metadata: { name: 'prod' } }] });
      }
      return JSON.stringify({ items: [] });
    });
    await runTriageModeSettled();

    expect(promptArg()).toContain('Infrastructure Drift Detected');
    expect(promptArg()).toContain('Namespace "prod" appeared');
    expect(stderrSpy.mock.calls.map((c: unknown[]) => c[0]).join('')).toContain('Drift detected: 1 change(s)');
  });

  it('does not overwrite the checkpoint when kubectl is unavailable', async () => {
    const checkpointFile = join(dir, 'checkpoint.jsonl');
    vi.mocked(loadConfig).mockReturnValue(
      baseConfig({ drift: { enabled: true, checkpointFile }, learning: { enabled: false } }) as never,
    );
    vi.mocked(runKubectl).mockRejectedValue(new Error('kubectl not found'));

    await runTriageMode({});

    await expect(readFile(checkpointFile, 'utf8')).rejects.toThrow();
    expect(stderrSpy.mock.calls.map((c: unknown[]) => c[0]).join('')).toContain('Drift snapshot skipped');
  });

  it('records a baseline entry for each critical/warning finding when learning is enabled', async () => {
    const baselineFile = join(dir, 'baselines.jsonl');
    vi.mocked(loadConfig).mockReturnValue(
      baseConfig({ learning: { enabled: true, baselineFile } }) as never,
    );
    const stdoutData =
      '- **Severity**: critical\n  **Resource**: Pod/api-7f in prod\n  **Message**: CrashLoopBackOff\n';
    vi.mocked(spawn).mockImplementation(() => fakeChild({ stdoutData }) as unknown as ReturnType<typeof spawn>);

    await runTriageMode({});

    const lines = (await readFile(baselineFile, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({ namespace: 'prod', kind: 'Pod', name: 'api-7f', occurrences: 1 });
    expect(stderrSpy.mock.calls.map((c: unknown[]) => c[0]).join('')).toContain('Recorded 1 baseline entry');
  });

  it('does not write baselines when learning is disabled', async () => {
    const baselineFile = join(dir, 'baselines.jsonl');
    vi.mocked(loadConfig).mockReturnValue(baseConfig({ learning: { enabled: false, baselineFile } }) as never);
    const stdoutData =
      '- **Severity**: critical\n  **Resource**: Pod/api-7f in prod\n  **Message**: CrashLoopBackOff\n';
    vi.mocked(spawn).mockImplementation(() => fakeChild({ stdoutData }) as unknown as ReturnType<typeof spawn>);

    await runTriageMode({});

    await expect(readFile(baselineFile, 'utf8')).rejects.toThrow();
  });
});
