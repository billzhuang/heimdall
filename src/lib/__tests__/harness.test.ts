import { describe, it, expect } from 'vitest';
import { BLOCKED_PREFIX } from '../harness.ts';

describe('BLOCKED_PREFIX', () => {
  it('is the canonical blocked response prefix', () => {
    expect(BLOCKED_PREFIX).toBe('BLOCKED: ');
  });
});
