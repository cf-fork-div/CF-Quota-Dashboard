import { DEFAULT_FREE_TIER_LIMITS } from './free-tier-limits';

import type {

  AccountAlertRule,

  AccountAlertSettings,

  AccountConfig,

  AlertCooldownEntry,

  AlertCooldownState,

  AlertItem,

  NotificationChannel,

} from './types';



export const DEFAULT_ALERT_THRESHOLD_PERCENT = 80;

/** Alert dedup window aligned with quota reset cadence (UTC calendar). */
export type AlertCooldownWindow = 'daily' | 'monthly';

/** Resolve dedup window from free-tier limit period. `total` metrics use daily. */
export function getAlertCooldownWindow(metricKey: string): AlertCooldownWindow {
  const def = DEFAULT_FREE_TIER_LIMITS[metricKey];
  if (def?.period === 'monthly') return 'monthly';
  return 'daily';
}

function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcMonthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** True when `lastAt` falls in a prior UTC calendar day/month for the given window. */
export function isNewAlertPeriod(
  lastAt: string,
  window: AlertCooldownWindow,
  now = new Date(),
): boolean {
  const last = new Date(lastAt);
  if (window === 'monthly') {
    return utcMonthKey(last) !== utcMonthKey(now);
  }
  return utcDateKey(last) !== utcDateKey(now);
}



/** Service groups for admin alert-rule UI (keys from free-tier-limits). */

export const ALERT_SERVICE_GROUPS: ReadonlyArray<{

  id: string;

  title: string;

  keys: readonly string[];

}> = [

  {

    id: 'workers',

    title: 'Workers',

    keys: [

      'workers_requests',

      'workers_build_minutes',

      'workers_build_concurrent',

      'workers_cpu_ms',

      'workers_logs_events',

      'workers_logs_bytes',

    ],

  },

  { id: 'pages', title: 'Pages', keys: ['pages_requests', 'pages_builds'] },

  {

    id: 'd1',

    title: 'D1',

    keys: ['d1_reads', 'd1_writes', 'd1_storage_gb', 'd1_databases'],

  },

  {

    id: 'kv',

    title: 'KV',

    keys: [

      'kv_reads',

      'kv_writes',

      'kv_deletes',

      'kv_lists',

      'kv_storage_gb',

      'kv_namespaces',

    ],

  },

  {

    id: 'r2',

    title: 'R2',

    keys: ['r2_storage_gb', 'r2_class_a', 'r2_class_b', 'r2_buckets'],

  },

  {

    id: 'vectorize',

    title: 'Vectorize',

    keys: ['vectorize_queried_dims', 'vectorize_stored_dims'],

  },

  { id: 'browser', title: 'Browser Run', keys: ['browser_minutes'] },

  { id: 'ai', title: 'Workers AI', keys: ['ai_neurons'] },

  { id: 'workflows', title: 'Workflows', keys: ['workflows_invocations'] },

  {

    id: 'durable_objects',

    title: 'Durable Objects',

    keys: [

      'durable_objects_requests',

      'durable_objects_duration',

      'durable_objects_rows_read',

      'durable_objects_rows_written',

      'durable_objects_sql_storage_gb',

    ],

  },

  { id: 'queues', title: 'Queues', keys: ['queues_ops'] },

  { id: 'hyperdrive', title: 'Hyperdrive', keys: ['hyperdrive_queries'] },

  { id: 'analytics', title: 'Analytics Engine', keys: ['analytics_engine_writes'] },

];



export function getMonitorableMetricKeys(): string[] {

  return Object.keys(DEFAULT_FREE_TIER_LIMITS);

}



export function clampAlertThreshold(value: unknown, fallback: number): number {

  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);

  if (Number.isFinite(n) && n > 0 && n <= 100) return n;

  return fallback;

}



function migrateLegacyAlerts(legacy: AccountAlertSettings | undefined): AccountAlertRule[] {

  if (!legacy?.enabled || !Array.isArray(legacy.metrics)) return [];

  const threshold = clampAlertThreshold(legacy.thresholdPercent, DEFAULT_ALERT_THRESHOLD_PERCENT);

  return legacy.metrics

    .filter((key) => key in DEFAULT_FREE_TIER_LIMITS)

    .map((metricKey) => ({

      metricKey,

      enabled: true,

      thresholdPercent: threshold,

    }));

}



export function normalizeAlertRules(

  input: AccountAlertRule[] | undefined,

  legacy?: AccountAlertSettings,

  defaultThreshold = DEFAULT_ALERT_THRESHOLD_PERCENT,

): AccountAlertRule[] {

  const source =

    Array.isArray(input) && input.length > 0 ? input : migrateLegacyAlerts(legacy);

  if (!source.length) return [];



  const byKey = new Map<string, AccountAlertRule>();

  for (const rule of source) {

    if (!rule?.metricKey || !(rule.metricKey in DEFAULT_FREE_TIER_LIMITS)) continue;

    byKey.set(rule.metricKey, {

      metricKey: rule.metricKey,

      enabled: rule.enabled === true,

      thresholdPercent: clampAlertThreshold(rule.thresholdPercent, defaultThreshold),

    });

  }



  return [...byKey.values()];

}



export function resolveEnabledAlertRules(account: AccountConfig): AccountAlertRule[] {

  return normalizeAlertRules(account.alertRules, account.alerts).filter((r) => r.enabled);

}



export function cooldownKey(accountId: string, metricKey: string): string {

  return `${accountId}:${metricKey}`;

}



export function shouldAlertAfterCooldown(

  entry: AlertCooldownEntry | undefined,

  pct: number,

  metricKey: string,

  now = Date.now(),

): boolean {

  if (!entry) return true;

  const window = getAlertCooldownWindow(metricKey);

  if (isNewAlertPeriod(entry.at, window, new Date(now))) return true;

  return pct > entry.pct;

}



export function filterAlertsByCooldown(

  alerts: AlertItem[],

  cooldown: AlertCooldownState,

): AlertItem[] {

  const now = Date.now();

  return alerts.filter((item) => {

    const key = cooldownKey(item.accountId, item.metricKey);

    return shouldAlertAfterCooldown(cooldown[key], item.metric.pct, item.metricKey, now);

  });

}



export function applyCooldownUpdates(

  cooldown: AlertCooldownState,

  alerts: AlertItem[],

  now = new Date(),

): AlertCooldownState {

  const next = { ...cooldown };

  const iso = now.toISOString();

  for (const item of alerts) {

    const key = cooldownKey(item.accountId, item.metricKey);

    next[key] = { pct: item.metric.pct, at: iso };

  }

  return next;

}



export type AccountAlertValidationResult =

  | { ok: true; notificationChannelId?: string }

  | { ok: false; error: string };



export function validateAccountAlertConfig(

  alertRules: AccountAlertRule[] | undefined,

  notificationChannelId: string | undefined,

  channels: NotificationChannel[],

  defaultThreshold = DEFAULT_ALERT_THRESHOLD_PERCENT,

): AccountAlertValidationResult {

  const normalized = normalizeAlertRules(alertRules, undefined, defaultThreshold);

  const hasEnabledRules = normalized.some((r) => r.enabled);



  if (!hasEnabledRules) {

    const trimmed = notificationChannelId?.trim();

    return { ok: true, notificationChannelId: trimmed || undefined };

  }



  const enabledChannels = channels.filter((c) => c.enabled);

  if (!enabledChannels.length) {

    return { ok: false, error: '通知渠道未配置，无法启用告警' };

  }



  const channelId = notificationChannelId?.trim();

  if (!channelId) {

    return { ok: false, error: '启用告警时必须选择通知渠道' };

  }



  if (!enabledChannels.some((c) => c.id === channelId)) {

    return { ok: false, error: '所选通知渠道不存在或未启用' };

  }



  return { ok: true, notificationChannelId: channelId };

}


