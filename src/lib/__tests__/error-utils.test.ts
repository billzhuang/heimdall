import { describe, it, expect } from 'vitest';
import { getMessage, getStackOrMessage, getExecErrorDetail } from '../error-utils.ts';

describe('getMessage', () => {
  it('returns message from an Error', () => {
    expect(getMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error values', () => {
    expect(getMessage('plain string')).toBe('plain string');
    expect(getMessage(42)).toBe('42');
    expect(getMessage(null)).toBe('null');
    expect(getMessage(undefined)).toBe('undefined');
    expect(getMessage({ toString: () => 'obj' })).toBe('obj');
  });
});

describe('getStackOrMessage', () => {
  it('returns the stack trace when present', () => {
    const err = new Error('boom');
    expect(getStackOrMessage(err)).toBe(err.stack);
  });

  it('falls back to message when stack is absent', () => {
    const err = new Error('no stack');
    delete (err as { stack?: string }).stack;
    expect(getStackOrMessage(err)).toBe('no stack');
  });

  it('stringifies non-Error values', () => {
    expect(getStackOrMessage('raw')).toBe('raw');
    expect(getStackOrMessage(99)).toBe('99');
  });
});

describe('getExecErrorDetail', () => {
  it('prefers stderr by default', () => {
    const err = { stderr: 'stderr text', stdout: 'stdout text', message: 'msg' };
    expect(getExecErrorDetail(err)).toBe('stderr text');
  });

  it('falls back to stdout when stderr is empty', () => {
    const err = { stderr: '', stdout: 'stdout text', message: 'msg' };
    expect(getExecErrorDetail(err)).toBe('stdout text');
  });

  it('falls back to message when both streams are empty', () => {
    const err = { stderr: '', stdout: '', message: 'msg' };
    expect(getExecErrorDetail(err)).toBe('msg');
  });

  it('falls back to String(error) as last resort', () => {
    const err = new Error('fallback');
    expect(getExecErrorDetail(err)).toContain('fallback');
  });

  it('prefers stdout when stdoutFirst is true', () => {
    const err = { stderr: 'stderr text', stdout: 'stdout text', message: 'msg' };
    expect(getExecErrorDetail(err, true)).toBe('stdout text');
  });

  it('trims surrounding whitespace', () => {
    const err = { stderr: '  trimmed  ', stdout: '', message: '' };
    expect(getExecErrorDetail(err)).toBe('trimmed');
  });
});
