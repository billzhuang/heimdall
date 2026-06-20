import { vi } from 'vitest';
import { execFile } from 'node:child_process';

export type ExecFileCb = (err: Error | null, result: { stdout: string; stderr: string }) => void;

export function stubExec(handler: (cmd: string, args: string[], opts: unknown, cb: ExecFileCb) => void): void {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(handler);
}

export function resetExec(): void {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockReset();
}
