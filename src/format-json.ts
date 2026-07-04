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
 *
 * When a `slack` block is configured (and enabled), the finding is also posted
 * to the configured Slack incoming webhook URL.
 *
 * When `learning.enabled` is true (default) and HEIMDALL_NO_LEARN is not set,
 * the prompt + finding are appended to the task-history JSONL log so the
 * self-improve reflector can learn from real investigations.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOneShotOutput } from './lib/format-output.ts';
import { loadConfig } from './lib/config.ts';
import { sendSlackNotification } from './lib/slack.ts';
import { buildTaskHistoryEntry, appendTaskHistoryEntry, resolveTaskHistoryFilePath } from './lib/task-history.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const model = process.env.HEIMDALL_MODEL ?? 'anthropic/claude-sonnet-4-6';

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk: string) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  const finding = parseOneShotOutput(raw, model);
  process.stdout.write(JSON.stringify(finding) + '\n');

  // Suppress Slack notifications and task-history logging during synthetic
  // eval/self-improve runs to avoid posting fake findings to real webhooks or
  // polluting the learning log with artificial data.
  if (process.env.HEIMDALL_EVAL_MODE === '1') return;

  const config = loadConfig();

  // --- Slack notification -----------------------------------------------
  const slackCfg = config.slack;
  if (slackCfg?.enabled) {
    const webhookUrl = slackCfg.webhookUrl || process.env.SLACK_WEBHOOK_URL || '';
    if (webhookUrl) {
      sendSlackNotification(finding, {
        webhookUrl,
        channel: slackCfg.channel,
        minSeverity: (slackCfg.minSeverity ?? 'warning') as 'info' | 'warning' | 'critical',
        timeoutMs: slackCfg.timeoutMs ?? 10_000,
      }).catch(() => {
        // sendSlackNotification never throws, but the Promise rejection is caught defensively.
      });
    }
  }

  // --- Task-history logging ---------------------------------------------
  // Skip if disabled via env var or config key.
  const learningEnabled = config.learning?.enabled !== false;
  if (learningEnabled && process.env.HEIMDALL_NO_LEARN !== '1') {
    const prompt = process.env.HEIMDALL_PROMPT ?? '';
    if (prompt) {
      const logPath = resolveTaskHistoryFilePath(config.learning?.file, resolve(__dirname, '..', 'scenarios'));
      const entry = buildTaskHistoryEntry(
        prompt,
        model,
        finding.severity ?? 'info',
        finding.summary ?? '',
      );
      appendTaskHistoryEntry(entry, logPath).catch(() => {
        // Never crash on logging failure — best-effort only.
      });
    }
  }
});
