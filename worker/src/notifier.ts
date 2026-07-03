import { sendToChannel } from './channels';
import {
  applyCooldownUpdates,
  filterAlertsByCooldown,
  resolveEnabledAlertRules,
} from './account-alerts';
import {
  getAlertCooldown,
  getChannels,
  saveAlertCooldown,
} from './kv-store';
import type {
  AccountConfig,
  AccountSnapshot,
  AlertItem,
  AlertMessage,
  Env,
  NotificationChannel,
  QuotaMetric,
  QuotaPeriod,
  SendResult,
} from './types';

const PERIOD_ZH: Record<QuotaPeriod, string> = {
  daily: '今日',
  monthly: '本月',
  total: '总计',
};

function formatUsed(metric: QuotaMetric): string {
  if (metric.unit === 'GB') return `${metric.used} GB`;
  if (metric.unit === 'bytes') return `${metric.used.toLocaleString()} B`;
  return metric.used.toLocaleString();
}

function formatLimit(metric: QuotaMetric): string {
  if (metric.unit === 'GB') return `${metric.limit} GB`;
  if (metric.unit === 'bytes') return `${metric.limit.toLocaleString()} B`;
  return metric.limit.toLocaleString();
}

function formatAlertTime(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';

  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function isR2Inactive(account: AccountSnapshot): boolean {
  return account.serviceStatus?.r2 === 'not_activated';
}

export function collectAlerts(
  snapshots: AccountSnapshot[],
  accountConfigs: AccountConfig[],
): AlertItem[] {
  const configByAccountId = new Map(accountConfigs.map((a) => [a.accountId, a]));
  const alerts: AlertItem[] = [];

  for (const snapshot of snapshots) {
    if (snapshot.status !== 'ok') continue;

    const config = configByAccountId.get(snapshot.accountId);
    if (!config?.enabled) continue;

    const rules = resolveEnabledAlertRules(config);
    if (!rules.length) continue;

    for (const rule of rules) {
      if (rule.metricKey.startsWith('r2_') && isR2Inactive(snapshot)) continue;
      const metric = snapshot.quotas[rule.metricKey];
      if (!metric?.available) continue;
      if (metric.pct >= rule.thresholdPercent) {
        alerts.push({
          account: snapshot.accountName,
          accountId: snapshot.accountId,
          metricKey: rule.metricKey,
          metric,
          thresholdPercent: rule.thresholdPercent,
        });
      }
    }
  }

  alerts.sort((a, b) => b.metric.pct - a.metric.pct);
  return alerts;
}

export interface FormatAlertOptions {
  isTest?: boolean;
}

export function formatAlertMessage(
  alerts: AlertItem[],
  options?: FormatAlertOptions,
): AlertMessage | null {
  if (!alerts.length) return null;

  const isTest = options?.isTest ?? false;
  const timeStr = formatAlertTime();
  const thresholds = [...new Set(alerts.map((a) => a.thresholdPercent))].sort((a, b) => a - b);
  const thresholdLabel =
    thresholds.length === 1
      ? `≥${thresholds[0]}%`
      : `≥${thresholds.join('%, ≥')}%`;

  const title = isTest
    ? `[测试] CF 配额告警 (${thresholdLabel})`
    : `CF 配额告警 (${thresholdLabel})`;

  const byAccount = new Map<string, AlertItem[]>();
  for (const alert of alerts) {
    const list = byAccount.get(alert.account) ?? [];
    list.push(alert);
    byAccount.set(alert.account, list);
  }

  const accountNames = [...byAccount.keys()];
  const singleAccount = accountNames.length === 1 ? accountNames[0] : null;

  const mdLines: string[] = [`## ${title}`, ''];
  const plainLines: string[] = [title, ''];

  if (singleAccount) {
    mdLines.push(`> 账号：${singleAccount}`);
    plainLines.push(`账号：${singleAccount}`);
  } else {
    mdLines.push(`> 告警账号：${accountNames.length} 个`);
    plainLines.push(`告警账号：${accountNames.length} 个`);
  }
  mdLines.push(`> 时间：${timeStr}`);
  plainLines.push(`时间：${timeStr}`);
  if (!isTest && alerts.length > 1) {
    mdLines.push(`> 告警项：${alerts.length}`);
    plainLines.push(`告警项：${alerts.length}`);
  }
  mdLines.push('');
  plainLines.push('');

  let shown = 0;
  const maxShow = 20;
  for (const [account, items] of byAccount) {
    if (shown >= maxShow) break;

    if (!singleAccount) {
      mdLines.push(`### ${account}`, '');
      plainLines.push(`【${account}】`, '');
    }

    for (const { metric, thresholdPercent } of items) {
      if (shown >= maxShow) break;

      const period = PERIOD_ZH[metric.period] || metric.period;
      const usageLine = `用量：${formatUsed(metric)} / ${formatLimit(metric)} (${metric.pct}%) · ${period}`;
      const thresholdLine = `阈值：≥ ${thresholdPercent}%`;

      mdLines.push(`**${metric.label}**`);
      mdLines.push(usageLine);
      mdLines.push(thresholdLine, '');

      plainLines.push(metric.label);
      plainLines.push(usageLine);
      plainLines.push(thresholdLine, '');

      shown++;
    }

    if (!singleAccount && shown < maxShow && items.length > 0) {
      mdLines.push('---', '');
      plainLines.push('---', '');
    }
  }

  if (alerts.length > maxShow) {
    mdLines.push(`_…还有 ${alerts.length - maxShow} 项告警_`, '');
    plainLines.push(`…还有 ${alerts.length - maxShow} 项告警`, '');
  }

  mdLines.push('---');
  plainLines.push('---');
  if (isTest) {
    mdLines.push('此为测试消息，请忽略');
    plainLines.push('此为测试消息，请忽略');
  } else {
    mdLines.push('CF Quota Dashboard');
    plainLines.push('CF Quota Dashboard');
  }

  return {
    title,
    content: plainLines.join('\n'),
    markdown: mdLines.join('\n'),
    alerts,
    threshold: thresholds[0],
  };
}

export function buildAlertContent(alerts: AlertItem[]): AlertMessage | null {
  return formatAlertMessage(alerts);
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
  snapshots: AccountSnapshot[],
  accountConfigs: AccountConfig[],
): Promise<boolean> {
  const allAlerts = collectAlerts(snapshots, accountConfigs);
  if (!allAlerts.length) return false;

  const cooldown = await getAlertCooldown(env.KV);
  const alerts = filterAlertsByCooldown(allAlerts, cooldown);
  if (!alerts.length) return false;

  const channels = await getChannels(env.KV);
  const channelById = new Map(channels.map((c) => [c.id, c]));
  const configByAccountId = new Map(accountConfigs.map((a) => [a.accountId, a]));

  const alertsByChannel = new Map<string, AlertItem[]>();

  for (const alert of alerts) {
    const config = configByAccountId.get(alert.accountId);
    const channelId = config?.notificationChannelId;
    if (!channelId) continue;

    const channel = channelById.get(channelId);
    if (!channel?.enabled) continue;

    const list = alertsByChannel.get(channelId) ?? [];
    list.push(alert);
    alertsByChannel.set(channelId, list);
  }

  if (!alertsByChannel.size) return false;

  let anySent = false;
  const sentAlerts: AlertItem[] = [];

  for (const [channelId, channelAlerts] of alertsByChannel) {
    const channel = channelById.get(channelId);
    if (!channel) continue;

    const message = buildAlertContent(channelAlerts);
    if (!message) continue;

    const result = await sendToChannel(channel, message);
    if (result.ok) {
      anySent = true;
      sentAlerts.push(...channelAlerts);
    }
  }

  if (anySent) {
    await saveAlertCooldown(env.KV, applyCooldownUpdates(cooldown, sentAlerts));
  }

  return anySent;
}

export interface ChannelTestOutcome {
  channelId: string;
  channelName: string;
  channelType: NotificationChannel['type'];
  ok: boolean;
  error?: string;
}

export function buildTestMessage(options?: { accountName?: string }): AlertMessage {
  const accountName = options?.accountName ?? '示例账号';
  const metric: QuotaMetric = {
    used: 85000,
    limit: 100000,
    pct: 85,
    unit: 'requests',
    period: 'daily',
    label: 'Workers Requests',
    available: true,
  };

  const sampleAlert: AlertItem = {
    account: accountName,
    accountId: 'test',
    metricKey: 'workers_requests',
    thresholdPercent: 80,
    metric,
  };

  return formatAlertMessage([sampleAlert], { isTest: true })!;
}

export async function sendTestNotification(
  channel: NotificationChannel,
  options?: { accountName?: string },
): Promise<SendResult> {
  return sendToChannel(channel, buildTestMessage(options));
}

export async function sendTestAlerts(
  env: Env,
  options?: { accountName?: string },
): Promise<{ channels: ChannelTestOutcome[]; sent: boolean }> {
  const channels = await resolveChannels(env);
  if (!channels.length) {
    return { channels: [], sent: false };
  }

  const message = buildTestMessage(options);
  const channels_result = await Promise.all(
    channels.map(async (channel) => {
      const result = await sendToChannel(channel, message);
      return {
        channelId: channel.id,
        channelName: channel.name,
        channelType: channel.type,
        ok: result.ok,
        error: result.error,
      };
    }),
  );

  return { channels: channels_result, sent: channels_result.some((r) => r.ok) };
}
