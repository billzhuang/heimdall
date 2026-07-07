/**
 * Characterization test for runWatchStream's baseline-recording branch,
 * pinning current behavior ahead of removing an unused `severity` local
 * (computed via inferDiagnosisSeverity, then immediately discarded via
 * `void severity` — upsertBaseline has no severity parameter to pass it to).
 *
 * kubectl and the diagnosing agent subprocess are mocked; baseline.ts runs
 * for real against a temp file so the JSONL write path is exercised too.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from 'node:child_process';
import { runWatchStream } from '../../watch-mode.ts';
import type { CooldownState } from '../watch.ts';

/** kubectl's stdout must be a real Readable so readline can consume it line by line. */
function fakeKubectlChild(lines: string[]) {
  const child = new EventEmitter();
  return Object.assign(child, {
    stdout: Readable.from([lines.join('\n') + '\n']),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
}

/** The diagnosing agent subprocess: reads stdout data, then closes. */
function fakeAgentChild(stdoutData: string) {
  const childEmitter = new EventEmitter();
  const stdout = new EventEmitter();
  setImmediate(() => {
    stdout.emit('data', Buffer.from(stdoutData));
    childEmitter.emit('close', 0, null);
  });
  return Object.assign(childEmitter, { stdout, stderr: new EventEmitter(), kill: vi.fn() });
}

const WARNING_EVENT = {
  kind: 'Event',
  type: 'Warning',
  reason: 'BackOff',
  message: 'Back-off restarting failed container',
  metadata: { namespace: 'prod', name: 'my-pod.abc123' },
  involvedObject: { kind: 'Pod', name: 'my-pod', namespace: 'prod' },
};

describe('runWatchStream — baseline recording', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'heimdall-watch-mode-'));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('records a baseline entry for a diagnosed Warning event', async () => {
    const baselineFile = join(dir, 'baselines.jsonl');
    vi.mocked(spawn)
      .mockImplementationOnce(
        () => fakeKubectlChild([JSON.stringify(WARNING_EVENT)]) as unknown as ReturnType<typeof spawn>,
      )
      .mockImplementationOnce(
        () => fakeAgentChild('Container is repeatedly OOM-killed.') as unknown as ReturnType<typeof spawn>,
      );

    const cooldownState: CooldownState = new Map();
    const controller = new AbortController();

    await runWatchStream(
      ['get', 'events', '--watch', '-o', 'json', '-A'],
      undefined,
      cooldownState,
      300,
      controller.signal,
      null,
      baselineFile,
    );

    const lines = (await readFile(baselineFile, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({
      namespace: 'prod',
      kind: 'Pod',
      name: 'my-pod',
      occurrences: 1,
      summary: '[BackOff] Container is repeatedly OOM-killed.',
    });
  });
});
