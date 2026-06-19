/**
 * Heimdall one-shot JSON mode.
 *
 * Invokes the Heimdall agent with a single prompt, captures the text
 * response, and emits one structured JSON line to stdout.  This is the
 * backing script for `heimdall --json -p "…"`.
 *
 * Usage (internal — bin/heimdall routes here):
 *   node dist/one-shot-mode.mjs --prompt "Why is my pod crash-looping?"
 *   tsx src/one-shot-mode.ts   --prompt "Why is my pod crash-looping?"
 *
 * Exit codes:
 *   0  — result written to stdout
 *   1  — argument error, agent error, or timeout
 */
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentResponse } from './lib/one-shot.ts';
import { DEFAULT_MODEL } from './lib/model.ts';

const TIMEOUT_MS = 300_000; // 5 minutes — same budget as triage mode

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Invoke `heimdall -p <prompt>` (text mode) and capture its stdout. */
async function captureAgentOutput(prompt: string): Promise<string> {
  const binPath = resolve(__dirname, '..', 'bin', 'heimdall');

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (val: string | Error) => {
      if (settled) return;
      settled = true;
      if (val instanceof Error) reject(val);
      else resolve(val);
    };

    const child = spawn(binPath, ['-p', prompt], {
      // stderr is inherited so the agent's status messages reach the terminal.
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(new Error('agent timed out after 5 minutes'));
    }, TIMEOUT_MS);

    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        settle(new Error(`agent exited with code ${code}`));
      } else {
        settle(output.trim());
      }
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      settle(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const promptIdx = process.argv.indexOf('--prompt');
if (promptIdx === -1 || !process.argv[promptIdx + 1]) {
  process.stderr.write('Error: --prompt <text> is required\n');
  process.exit(1);
}
const prompt = process.argv[promptIdx + 1];

try {
  const text = await captureAgentOutput(prompt);
  const result = parseAgentResponse(text, DEFAULT_MODEL);
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
