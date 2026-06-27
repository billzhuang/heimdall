import { vi } from 'vitest';
import { BLOCKED_PREFIX } from '../harness.ts';

export function mockFetch(body: string, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    text: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export function makeAbortError(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

export const BLOCKED_RE = new RegExp(`^${BLOCKED_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
