import { describe, it, expect } from 'vitest';
import { interpretChildExit } from '../child-exit.ts';

describe('interpretChildExit', () => {
  it('returns null for a clean exit (code 0, no signal)', () => {
    expect(interpretChildExit(0, null)).toBeNull();
  });

  it('returns an Error for a non-zero exit code', () => {
    const err = interpretChildExit(1, null);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe('heimdall exited with code 1');
  });

  it('returns an Error when killed by a signal (code null)', () => {
    const err = interpretChildExit(null, 'SIGTERM');
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe('heimdall killed by signal SIGTERM');
  });

  it('returns null when code is null and signal is null (defensive default)', () => {
    expect(interpretChildExit(null, null)).toBeNull();
  });
});
