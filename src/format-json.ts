/**
 * Heimdall JSON formatter — stdin → JSON stdout.
 *
 * Reads the full agent output from stdin, parses it with parseOneShotOutput,
 * and writes a single JSON line to stdout.  Invoked by bin/heimdall --json
 * as the second stage of a two-process pipe:
 *
 *   printf '%s\n' "$PROMPT" | flue connect heimdall local | node format-json.mjs
 *
 * Exit code mirrors the pipe: the script exits 0 on success; the wrapping
 * shell's pipefail propagates a non-zero exit from the upstream flue process.
 */
import { parseOneShotOutput } from './lib/format-output.ts';

const model = process.env.HEIMDALL_MODEL ?? 'anthropic/claude-sonnet-4-6';

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk: string) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  const finding = parseOneShotOutput(raw, model);
  process.stdout.write(JSON.stringify(finding) + '\n');
});
