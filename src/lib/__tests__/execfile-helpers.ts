import { vi } from 'vitest';
import { execFile } from 'node:child_process';

export type ExecFileCb = (err: Error | null, result: { stdout: string; stderr: string }) => void;

export function stubExec(handler: (cmd: string, args: string[], opts: unknown, cb: ExecFileCb) => void): void {
  vi.mocked(execFile).mockImplementation(handler as never);
}

export function resetExec(): void {
  vi.mocked(execFile).mockReset();
}
