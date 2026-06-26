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

export interface SlackConfig {
  webhookUrl: string;
  channel?: string | null;
  /** Minimum severity that triggers a notification. */
  minSeverity: 'info' | 'warning' | 'critical';
  timeoutMs: number;
}

/** Maximum characters for a Slack section text block (API limit is 3 001; we use 2 000 for safety). */
export const MAX_SLACK_TEXT_CHARS = 2_000;
/** Maximum bullet lines extracted from the Thinking Summary section. */
export const MAX_BULLET_LINES = 3;
/** Maximum suggested kubectl commands shown in the notification. */
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const detail = body ? `: ${body.slice(0, 200)}` : '';
      process.stderr.write(
        `[heimdall] Slack notification failed (HTTP ${response.status})${detail}\n`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      process.stderr.write(
        `[heimdall] Slack notification timed out after ${config.timeoutMs}ms.\n`,
      );
    } else {
      process.stderr.write(
        `[heimdall] Slack notification error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
