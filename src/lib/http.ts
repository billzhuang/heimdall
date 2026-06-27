import { applyRedaction, type CompiledRedactionRule } from './regex-redact.ts';

/**
 * Issue a fetch with a hard timeout enforced via AbortController.
 * The handler runs inside the timer window so body consumption is also
 * covered by the timeout — clearing the timer only after handler resolves.
 */
export async function fetchWithTimeout<T>(
  url: URL | string,
  timeoutMs: number,
  handler: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return await handler(response);
  } finally {
    clearTimeout(timer);
  }
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
