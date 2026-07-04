import { applyRedaction, type CompiledRedactionRule } from './regex-redact.ts';
import { getMessage } from './error-utils.ts';

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

/** Cap a body string at 200 characters and format it as a `: <body>` suffix (empty string when blank). */
function truncatedDetail(body: string): string {
  return body ? `: ${body.slice(0, 200)}` : '';
}

/** Format `"<label> HTTP <status> <statusText><detail>"` for a non-2xx Response. */
function formatHttpStatusLine(label: string, response: Response, detail: string): string {
  return `${label} HTTP ${response.status} ${response.statusText}${detail}`;
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
    return truncatedDetail(applyRedaction(body, redactionRules));
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    return '';
  }
}

/**
 * Create a reusable response handler for `fetchWithTimeout` calls.
 *
 * On a non-2xx response, returns `"${serviceName} HTTP <status> <statusText>[: <body>]"`.
 * On success, returns `truncate(applyRedaction(body, rules))`.
 * AbortErrors from `readErrorDetail` are re-thrown so the outer catch can report them as timeouts.
 */
export function makeResponseHandler(
  serviceName: string,
  rules: CompiledRedactionRule[],
  truncate: (s: string) => string,
): (response: Response) => Promise<string> {
  return async (response) => {
    if (!response.ok) {
      const detail = await readErrorDetail(response, rules);
      return formatHttpStatusLine(serviceName, response, detail);
    }
    const text = await response.text();
    return truncate(applyRedaction(text, rules));
  };
}

/**
 * Format a non-2xx fetch Response as "<label> HTTP <status> <statusText>[: <body>]",
 * capping the body detail at 200 characters. Body-read failures (including an
 * abort) are swallowed, producing the bare "HTTP <status> <statusText>" message.
 */
export async function formatHttpErrorMessage(response: Response, label: string): Promise<string> {
  const body = await response.text().catch(() => '');
  return formatHttpStatusLine(label, response, truncatedDetail(body));
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
  const message = getMessage(err);
  return `${service} query failed: ${applyRedaction(message, redactionRules)}`;
}

/**
 * Run a multi-endpoint query dispatcher under a timeout, then truncate and
 * redact its result; catch any error (including timeout) into `formatQueryError`.
 *
 * Centralizes the timeout / truncate / redact / catch-and-format sequence shared
 * by query tools that route to one of several endpoints based on a `queryType`
 * (Datadog, New Relic), as opposed to `runJsonQuery`'s single-endpoint shape.
 */
export async function runDispatchedQuery(
  timeoutMs: number,
  serviceName: string,
  redactionRules: CompiledRedactionRule[],
  truncate: (s: string) => string,
  dispatch: (signal: AbortSignal) => Promise<string>,
): Promise<string> {
  try {
    return await withTimeout(timeoutMs, async (signal) => truncate(applyRedaction(await dispatch(signal), redactionRules)));
  } catch (err) {
    return formatQueryError(err, serviceName, timeoutMs, redactionRules);
  }
}

/** Minimal shape shared by the query-tool configs that call `runJsonQuery`. */
export interface JsonQueryConfig {
  url: string;
  timeoutMs: number;
  regexRedactionRules?: CompiledRedactionRule[];
}

/**
 * Build a `<config.url><path>` request URL, let `setParams` fill in its query
 * string, then run it through `fetchWithTimeout` + `makeResponseHandler`,
 * catching any error into `formatQueryError`.
 *
 * Centralizes the build-URL / fetch-with-timeout / catch-and-format sequence
 * shared by every read-only query tool (Prometheus, Loki, Kubecost, Jaeger, ...).
 */
export async function runJsonQuery(
  config: JsonQueryConfig,
  path: string,
  serviceName: string,
  truncate: (s: string) => string,
  setParams: (searchParams: URLSearchParams) => void,
): Promise<string> {
  try {
    const baseUrl = new URL(config.url);
    baseUrl.pathname = baseUrl.pathname.replace(/\/$/, '') + path;
    setParams(baseUrl.searchParams);

    return await fetchWithTimeout(
      baseUrl.toString(),
      config.timeoutMs,
      makeResponseHandler(serviceName, config.regexRedactionRules ?? [], truncate),
    );
  } catch (err) {
    return formatQueryError(err, serviceName, config.timeoutMs, config.regexRedactionRules ?? []);
  }
}
