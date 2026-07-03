import { sendToChannel } from './channels';
import { getChannels } from './kv-store';
import type {
  AccountSnapshot,
  AlertItem,
  AlertMessage,
  Env,
  NotificationChannel,
  QuotaMetric,
  SendResult,
} from './types';

function formatUsed(metric: QuotaMetric): string {
  if (metric.unit === 'GB') return `${metric.used} GB`;
  if (metric.unit === 'bytes') return `${metric.used} B`;
  return String(metric.used);
}

export function collectAlerts(
  accounts: AccountSnapshot[],
  threshold: number,
): AlertItem[] {
  const alerts: AlertItem[] = [];
  for (const account of accounts) {
    if (account.status !== 'ok') continue;
    for (const metric of Object.values(account.quotas)) {
      if (metric.available && metric.pct >= threshold) {
        alerts.push({ account: account.accountName, metric });
      }
    }
  }
  alerts.sort((a, b) => b.metric.pct - a.metric.pct);
  return alerts;
}

export function buildAlertContent(
  alerts: AlertItem[],
  threshold: number,
): AlertMessage | null {
  if (!alerts.length) return null;

  const lines = alerts.slice(0, 20).map(({ account, metric }) => {
    const used = formatUsed(metric);
    return `- **${account}** · ${metric.label}: ${used} (${metric.pct}% of ${metric.limit} ${metric.unit}/${metric.period})`;
  });

  const plainLines = alerts.slice(0, 20).map(({ account, metric }) => {
    const used = formatUsed(metric);
    return `- ${account} · ${metric.label}: ${used} (${metric.pct}% of ${metric.limit} ${metric.unit}/${metric.period})`;
  });

  const title = `CF Quota Alert (≥${threshold}%)`;
  const markdown = [
    `## ${title}`,
    '',
    ...lines,
    alerts.length > 20 ? `\n_...and ${alerts.length - 20} more_` : '',
    '',
    `_Updated: ${new Date().toISOString()}_`,
  ].join('\n');

  const content = [
    title,
    '',
    ...plainLines,
    alerts.length > 20 ? `\n...and ${alerts.length - 20} more` : '',
    '',
    `Updated: ${new Date().toISOString()}`,
  ].join('\n');

  return { title, content, markdown, alerts, threshold };
}

function legacyWebhookChannel(webhookUrl: string): NotificationChannel {
  return {
    id: 'legacy-webhook',
    type: 'wecom',
    name: 'Legacy WEBHOOK_URL',
    enabled: true,
    config: { webhookUrl },
  };
}

async function resolveChannels(env: Env): Promise<NotificationChannel[]> {
  const channels = await getChannels(env.KV);

  if (channels.length > 0) {
    return channels.filter((c) => c.enabled);
  }

  const legacyUrl = env.WEBHOOK_URL?.trim();
  if (legacyUrl) return [legacyWebhookChannel(legacyUrl)];

  return [];
}

export async function sendQuotaAlert(
  env: Env,
  accounts: AccountSnapshot[],
  threshold: number,
): Promise<boolean> {
  const alerts = collectAlerts(accounts, threshold);
  const message = buildAlertContent(alerts, threshold);
  if (!message) return false;

  const channels = await resolveChannels(env);
  if (!channels.length) return false;

  const results = await Promise.all(
    channels.map((channel) => sendToChannel(channel, message)),
  );

  return results.some((r) => r.ok);
}

export function buildTestMessage(): AlertMessage {
  const now = new Date().toISOString();
  return {
    title: 'CF Quota Dashboard — Test Notification',
    content: [
      'CF Quota Dashboard — Test Notification',
      '',
      'This is a test message from your notification channel configuration.',
      'If you received this, the channel is working correctly.',
      '',
      `Sent at: ${now}`,
    ].join('\n'),
    markdown: [
      '## CF Quota Dashboard — Test Notification',
      '',
      'This is a **test message** from your notification channel configuration.',
      'If you received this, the channel is working correctly.',
      '',
      `_Sent at: ${now}_`,
    ].join('\n'),
    alerts: [],
    threshold: 0,
  };
}

export async function sendTestNotification(
  channel: NotificationChannel,
): Promise<SendResult> {
  return sendToChannel(channel, buildTestMessage());
}
