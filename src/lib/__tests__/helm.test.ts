/**
 * Tests for runHelm — policy / input validation only.
 *
 * Real `helm` is NOT invoked: we only assert the validation paths that return
 * error strings before execFile is ever reached. Tests that need to verify
 * allowed calls must mock runHelm at the tool layer.
 */
import { describe, it, expect } from 'vitest';
import { runHelm, ALLOWED_HELM_ACTIONS, ALLOWED_HELM_GET_TYPES } from '../helm.ts';

describe('runHelm — input validation', () => {
  it('requires a release name for the status action', async () => {
    const result = await runHelm('status', {});
    expect(result).toMatch(/release name is required/i);
  });

  it('requires a release name for the get action', async () => {
    const result = await runHelm('get', {});
    expect(result).toMatch(/release name is required/i);
  });

  it('requires getType for the get action', async () => {
    const result = await runHelm('get', { release: 'my-app' });
    expect(result).toMatch(/getType is required/i);
  });

  it('rejects an invalid getType', async () => {
    // @ts-expect-error — deliberately passing a value outside the type
    const result = await runHelm('get', { release: 'my-app', getType: 'install' });
    expect(result).toMatch(/invalid getType/i);
  });

  it('ALLOWED_HELM_ACTIONS contains exactly list, status, and get', () => {
    expect([...ALLOWED_HELM_ACTIONS].sort()).toEqual(['get', 'list', 'status']);
  });

  it('ALLOWED_HELM_GET_TYPES contains exactly values, manifest, and notes', () => {
    expect([...ALLOWED_HELM_GET_TYPES].sort()).toEqual(['manifest', 'notes', 'values']);
  });
});
