import { applyRedaction, type CompiledRedactionRule } from './regex-redact.ts';

/** Issue a fetch with a hard timeout enforced via AbortController. */
export async function fetchWithTimeout(url: URL | string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the error body from a non-2xx response, apply redaction, and format it
 * as a `: <body>` detail string (empty string when the body is blank).
 */
export async function readErrorDetail(
  response: Response,
  redactionRules: CompiledRedactionRule[],
): Promise<string> {
  const body = await response.text().catch(() => '');
  const redacted = applyRedaction(body, redactionRules);
  return redacted ? `: ${redacted.slice(0, 200)}` : '';
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
