import { applyRedaction, type CompiledRedactionRule } from './regex-redact.ts';

/**
 * Run an async operation under a hard AbortController timeout.
 * The timer is cleared only after the operation resolves, so body
 * consumption inside the operation is also covered by the timeout.
 */
export async function withTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Issue a fetch with a hard timeout; body consumption is covered by the same timer. */
export function fetchWithTimeout<T>(
  url: URL | string,
  timeoutMs: number,
  handler: (response: Response) => Promise<T>,
): Promise<T> {
  return withTimeout(timeoutMs, (signal) => fetch(url, { signal }).then(handler));
}

/**
 * Read the error body from a non-2xx response, apply redaction, and format it
 * as a `: <body>` detail string (empty string when the body is blank).
 * AbortError is re-thrown so the outer catch can report it as a timeout.
 */
export async function readErrorDetail(
  response: Response,
  redactionRules: CompiledRedactionRule[],
): Promise<string> {
  try {
    const body = await response.text();
    const redacted = applyRedaction(body, redactionRules);
    return redacted ? `: ${redacted.slice(0, 200)}` : '';
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    return '';
  }
}

/**
 * Format a caught fetch error as a human-readable string.
 * AbortErrors produce a timeout message; all other errors produce a "failed" message.
 * The error message is redacted before returning.
 */
export function formatQueryError(
  err: unknown,
  service: string,
  timeoutMs: number,
  redactionRules: CompiledRedactionRule[],
): string {
  if (err instanceof Error && err.name === 'AbortError') {
    return `${service} query timed out after ${timeoutMs}ms.`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `${service} query failed: ${applyRedaction(message, redactionRules)}`;
}
