/**
 * Pi Durable CLI runner for Heimdall one-shot and durable prompt execution.
 *
 * Replaces `flue connect heimdall local --target node` with a direct
 * `@earendil-works/pi-durable` execution entrypoint.
 *
 * Usage:
 *   tsx src/pi-runner.ts -p "Why is my pod crash-looping?"
 *   printf '%s\n' "Why is my pod crash-looping?" | tsx src/pi-runner.ts
 */
import heimdallAgent from './agents/heimdall.ts';
import {
  handleHelpOrUnknownOption,
  isMainModule,
  parseModelFlag,
  parseRequiredFlag,
  resolveModelOrExit,
} from './lib/cli-args.ts';
import { getMessage } from './lib/error-utils.ts';
import type { DefinedAgent, RunAgentPromptOptions } from './lib/pi-durable.ts';

const PI_RUNNER_HELP_TEXT = `Usage: tsx src/pi-runner.ts [-p <prompt>] [--model <provider/model>] [--sqlite <path>]

Run a single prompt through the Heimdall Pi Durable agent.

Options:
  -p, --prompt <text>         Prompt to send (reads from stdin if omitted)
      --model <provider/id>   Override the LLM model
      --sqlite <path>         Optional SQLite database file path for durable state
  -h, --help                  Show this help message
`;

export interface PiRunnerCliArgs {
  prompt?: string;
  modelFlag?: string;
  sqlitePath?: string;
}

/** Parse CLI arguments for `pi-runner.ts`. */
export function parsePiRunnerArgs(args: string[]): PiRunnerCliArgs {
  const result: PiRunnerCliArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-p' || arg === '--prompt' || arg.startsWith('--prompt=')) {
      const parsed = parseRequiredFlag(
        args,
        i,
        '--prompt=',
        `${arg} requires a prompt argument`,
        '--prompt= requires a non-empty value',
      );
      result.prompt = parsed.value;
      i = parsed.nextIndex;
    } else if (arg === '--model' || arg.startsWith('--model=')) {
      const parsed = parseModelFlag(args, i);
      result.modelFlag = parsed.value;
      i = parsed.nextIndex;
    } else if (arg === '--sqlite' || arg.startsWith('--sqlite=')) {
      const parsed = parseRequiredFlag(
        args,
        i,
        '--sqlite=',
        '--sqlite requires a file path',
        '--sqlite= requires a non-empty file path',
      );
      result.sqlitePath = parsed.value;
      i = parsed.nextIndex;
    } else {
      handleHelpOrUnknownOption(arg, PI_RUNNER_HELP_TEXT);
    }
  }

  return result;
}

/** Run a single prompt through a Pi Durable agent and return the output text. */
export async function runPiAgentPrompt(
  prompt: string,
  options: RunAgentPromptOptions = {},
  agent: DefinedAgent = heimdallAgent,
): Promise<string> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error('Prompt must not be empty');
  }
  const { text } = await agent.prompt(trimmed, options);
  return text;
}

async function readStdin(): Promise<string> {
  let raw = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) {
    raw += String(chunk);
  }
  return raw.trim();
}

if (isMainModule(import.meta.url)) {
  (async () => {
    const { prompt: flagPrompt, modelFlag, sqlitePath } = parsePiRunnerArgs(process.argv.slice(2));
    const model = resolveModelOrExit(modelFlag);
    const promptText = flagPrompt ?? (await readStdin());
    const output = await runPiAgentPrompt(promptText, { model, sqlitePath });
    process.stdout.write(`${output}\n`);
  })().catch((err: unknown) => {
    process.stderr.write(`Error: ${getMessage(err)}\n`);
    process.exit(1);
  });
}
