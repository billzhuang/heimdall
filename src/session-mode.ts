/**
 * Heimdall session mode — durable multi-turn SRE debugging sessions.
 *
 * Uses @flue/sdk to talk to a running Flue server (default: http://localhost:3000,
 * started with `flue dev --target node` or `heimdall serve`).  Each session is
 * identified by a UUID that maps 1:1 to a persistent Flue agent instance; Flue's
 * durable streams keep the conversation alive across process restarts.
 *
 * Usage:
 *   heimdall session start [--name <label>] [--server <url>]
 *   heimdall session prompt "<question>" --session <id>
 *   heimdall session list
 *   heimdall session info  <id>
 *   heimdall session end   <id>
 *
 * Environment overrides:
 *   HEIMDALL_SESSION_DIR  – directory for session handle files (default: ~/.heimdall/sessions)
 *   HEIMDALL_SERVER       – default Flue server URL (default: http://localhost:3000)
 */
import { createFlueClient } from '@flue/sdk';
import {
  createSession,
  deleteSession,
  listSessions,
  loadSession,
  updateSession,
  type SessionRecord,
} from './lib/session.ts';
import { getMessage } from './lib/error-utils.ts';
import { isMainModule } from './lib/cli-args.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

export function formatSession(s: SessionRecord): string {
  const label = s.name ? ` (${s.name})` : '';
  const last = s.lastPromptAt
    ? `last prompt ${new Date(s.lastPromptAt).toLocaleString()}`
    : 'no prompts yet';
  return `  ${s.id}${label}\n    server: ${s.serverUrl}  |  created: ${new Date(s.createdAt).toLocaleString()}  |  ${last}`;
}

function die(msg: string, code = 1): never {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(code);
}

/**
 * Parse a `--flag <value>` / `--flag=<value>` style option at `args[i]`. Call
 * only when the caller has already matched `args[i]` against `prefix` (the
 * `=` form) or one of the flag's own aliases (the space form).
 *
 * Note: the `=` form is not validated for emptiness here (matching each
 * call site's pre-existing behavior) while the space form dies via `die()`
 * when the following token is absent, same as the hand-rolled blocks this
 * replaces.
 */
function parseFlagValue(
  args: string[],
  i: number,
  prefix: string,
  requireMsg: string,
): { value: string; nextIndex: number } {
  const a = args[i];
  if (a.startsWith(prefix)) {
    return { value: a.slice(prefix.length), nextIndex: i };
  }
  const value = args[++i];
  if (!value) die(requireMsg);
  return { value, nextIndex: i };
}

/** Resolve a session id from --session/-s, --session=<id>, or the first positional arg. */
export function resolveSessionIdArg(args: string[]): string | undefined {
  let sessionId: string | undefined = args.find((a) => !a.startsWith('-'));

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--session' || a === '-s') {
      sessionId = args[++i];
    } else if (a.startsWith('--session=')) {
      sessionId = a.slice('--session='.length);
    }
  }

  return sessionId;
}

function showHelp(): void {
  process.stdout.write(`Usage:
  heimdall session start [--name <label>] [--server <url>]
  heimdall session prompt "<question>" --session <id>
  heimdall session list
  heimdall session info  <id>
  heimdall session end   <id>

Subcommands:
  start    Create a new durable debugging session and print its ID.
  prompt   Send a follow-up message to an existing session.
  list     List all local session handles.
  info     Print details about one session.
  end      Tear down a session (removes the local handle; server state is GC'd by Flue).

Options:
  --name <label>   Human-readable label for the session (start only).
  --server <url>   Flue server base URL (default: http://localhost:3583 or HEIMDALL_SERVER).
                   Run: flue dev --target node (or npm run dev) to start the local server.
  --session <id>   Session ID (prompt/info/end; can also be the first positional after subcommand).
  -h, --help       Show this help message.

Examples:
  heimdall session start --name prod-incident
  heimdall session prompt "Why is the api pod crash-looping?" --session <id>
  heimdall session prompt "What about the memory limits?"     --session <id>
  heimdall session list
  heimdall session end <id>
`);
}

// ── subcommand implementations ────────────────────────────────────────────────

export function cmdStart(args: string[]): void {
  let name: string | undefined;
  // Use || so an empty-string env var falls back to the default.
  let serverUrl: string =
    process.env['HEIMDALL_SERVER'] || 'http://localhost:3583';

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--name' || a === '-n' || a.startsWith('--name=')) {
      ({ value: name, nextIndex: i } = parseFlagValue(args, i, '--name=', '--name requires a value'));
    } else if (a === '--server' || a.startsWith('--server=')) {
      ({ value: serverUrl, nextIndex: i } = parseFlagValue(args, i, '--server=', '--server requires a value'));
    } else if (a === '-h' || a === '--help') {
      showHelp(); process.exit(0);
    } else {
      die(`unknown option for session start: ${a}`);
    }
  }

  try {
    new URL(serverUrl);
  } catch (err) {
    die(`Invalid server URL "${serverUrl}": ${(err as Error).message}`);
  }

  const session = createSession({ name, serverUrl });
  process.stdout.write(`Session created:\n${formatSession(session)}\n\nSession ID: ${session.id}\n`);
}

export async function cmdPrompt(args: string[]): Promise<void> {
  let sessionId: string | undefined;
  let message: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--session' || a === '-s' || a.startsWith('--session=')) {
      ({ value: sessionId, nextIndex: i } = parseFlagValue(args, i, '--session=', '--session requires a value'));
    } else if (a === '-h' || a === '--help') {
      showHelp(); process.exit(0);
    } else if (!message && !a.startsWith('-')) {
      message = a;
    } else {
      die(`unknown option for session prompt: ${a}`);
    }
  }

  if (!message) die('a message is required — e.g. heimdall session prompt "Why is my pod crash-looping?" --session <id>');
  if (!sessionId) die('--session <id> is required');

  let session: SessionRecord;
  try {
    session = loadSession(sessionId);
  } catch (err) {
    die((err as Error).message);
  }

  try {
    new URL(session.serverUrl);
  } catch (err) {
    die(`Invalid server URL "${session.serverUrl}" configured for session ${session.id}: ${(err as Error).message}`);
  }

  const client = createFlueClient({ baseUrl: session.serverUrl });

  process.stderr.write(`[heimdall-session] Sending prompt to session ${session.id} at ${session.serverUrl}...\n`);

  let result: { result: { text: string } };
  try {
    result = await client.agents.prompt('heimdall', session.id, { message });
  } catch (err) {
    die(
      `Failed to reach Flue server at ${session.serverUrl}: ${getMessage(err)}\n` +
      `Make sure a Heimdall Flue server is running:\n` +
      `  flue dev --target node\n` +
      `  (or pass a different URL with --server when creating the session)`
    );
  }

  process.stdout.write(`\n${result.result.text}\n`);

  // Best-effort metadata update — don't hide a successful response on FS error.
  try {
    session.lastPromptAt = new Date().toISOString();
    updateSession(session);
  } catch (err) {
    process.stderr.write(`[heimdall-session] Warning: failed to persist session metadata: ${getMessage(err)}\n`);
  }
}

function cmdList(): void {
  const sessions = listSessions();
  if (sessions.length === 0) {
    process.stdout.write('No active sessions.\n');
    return;
  }
  process.stdout.write(`${sessions.length} session(s):\n\n`);
  sessions.forEach((s) => process.stdout.write(`${formatSession(s)}\n\n`));
}

export function cmdInfo(args: string[]): void {
  const sessionId = resolveSessionIdArg(args);
  if (!sessionId) die('session id is required — heimdall session info <id>');

  let session: SessionRecord;
  try {
    session = loadSession(sessionId);
  } catch (err) {
    die((err as Error).message);
  }
  process.stdout.write(`${formatSession(session)}\n`);
}

export function cmdEnd(args: string[]): void {
  const sessionId = resolveSessionIdArg(args);
  if (!sessionId) die('session id is required — heimdall session end <id>');

  try {
    deleteSession(sessionId);
  } catch (err) {
    die((err as Error).message);
  }
  process.stdout.write(`Session ${sessionId} ended.\n`);
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (isMainModule(import.meta.url)) {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    showHelp();
    process.exit(0);
  }

  switch (subcommand) {
    case 'start':
      cmdStart(rest);
      break;
    case 'prompt':
      cmdPrompt(rest).catch((err: unknown) => {
        process.stderr.write(`Error: ${getMessage(err)}\n`);
        process.exit(1);
      });
      break;
    case 'list':
      cmdList();
      break;
    case 'info':
      cmdInfo(rest);
      break;
    case 'end':
      cmdEnd(rest);
      break;
    default:
      die(`unknown session subcommand: ${subcommand}\nRun 'heimdall session --help' for usage.`);
  }
}
