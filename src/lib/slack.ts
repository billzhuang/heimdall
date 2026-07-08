/**
 * Slack notification sink for Heimdall investigation findings.
 *
 * Posts a Block Kit message to a Slack incoming webhook URL after a --json
 * investigation or triage run.  The webhook URL comes exclusively from trusted
 * config/env — it is never a model-selected argument.
 *
 * Failure to notify is non-fatal: the function logs to stderr and returns
 * without throwing so the calling code can emit its result normally.
 */
import type { OneShotFinding } from './format-output.ts';
import { withTimeout, truncatedDetail } from './http.ts';
import { getMessage, isAbortError } from './error-utils.ts';

export interface SlackConfig {
  webhookUrl: string;
  channel?: string | null;
  /** Minimum severity that triggers a notification. */
  minSeverity: 'info' | 'warning' | 'critical';
  timeoutMs: number;
}

/** Slack Block Kit section text limit is 3 000 chars; 2 000 leaves headroom for mrkdwn escaping. */
export const MAX_SLACK_TEXT_CHARS = 2_000;
export const MAX_BULLET_LINES = 3;
export const MAX_SUGGESTED_COMMANDS = 3;

const SEVERITY_EMOJI: Record<string, string> = {
  critical: ':rotating_light:',
  warning: ':warning:',
  info: ':information_source:',
};

const SEVERITY_ORDER: Record<string, number> = { info: 0, warning: 1, critical: 2 };

export function meetsMinSeverity(severity: string, minSeverity: string): boolean {
  return (SEVERITY_ORDER[severity] ?? 0) >= (SEVERITY_ORDER[minSeverity] ?? 0);
}

function buildBlockKitPayload(finding: OneShotFinding, channel?: string | null): object {
  const emoji = SEVERITY_EMOJI[finding.severity] ?? ':mag:';

  const blocks: object[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} Heimdall: ${finding.severity.toUpperCase()}`,
        emoji: true,
      },
    },
  ];

  // Top bullet points from the Thinking Summary section.
  const bullets = finding.summary
    .split('\n')
    .filter((l) => l.trim().startsWith('-'))
    .slice(0, MAX_BULLET_LINES)
    .map((l) => l.trim())
    .join('\n');

  if (bullets) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Key findings:*\n${bullets}` },
    });
  }

  // Fallback to a placeholder if the answer is empty: Slack rejects empty text fields.
  const answerText = finding.answer.trim().slice(0, MAX_SLACK_TEXT_CHARS) || '_No answer provided._';
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: answerText },
  });

  // Top suggested kubectl commands as a fenced code block.
  if (finding.suggestedCommands.length > 0) {
    const cmds = finding.suggestedCommands.slice(0, MAX_SUGGESTED_COMMANDS).join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Suggested commands:*\n\`\`\`\n${cmds}\n\`\`\`` },
    });
  }

  const payload: Record<string, unknown> = { blocks };
  if (channel) payload['channel'] = channel;
  return payload;
}

/**
 * Post an investigation finding to a Slack incoming webhook.
 *
 * Returns without throwing on any failure; all errors are logged to stderr.
 */
export async function sendSlackNotification(
  finding: OneShotFinding,
  config: SlackConfig,
): Promise<void> {
  if (!meetsMinSeverity(finding.severity, config.minSeverity)) return;

  const payload = buildBlockKitPayload(finding, config.channel);

  try {
    await withTimeout(config.timeoutMs, async (signal) => {
      const response = await fetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        process.stderr.write(
          `[heimdall] Slack notification failed (HTTP ${response.status})${truncatedDetail(body)}\n`,
        );
      }
    });
  } catch (err) {
    if (isAbortError(err)) {
      process.stderr.write(
        `[heimdall] Slack notification timed out after ${config.timeoutMs}ms.\n`,
      );
    } else {
      process.stderr.write(
        `[heimdall] Slack notification error: ${getMessage(err)}\n`,
      );
    }
  }
}
