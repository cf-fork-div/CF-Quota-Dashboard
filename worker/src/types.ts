export type QuotaPeriod = 'daily' | 'monthly' | 'total';

export interface QuotaMetric {
  used: number;
  limit: number;
  pct: number;
  unit: string;
  period: QuotaPeriod;
  label: string;
  /** false when the public API does not expose this counter */
  available: boolean;
  /** optional note shown in UI */
  note?: string;
}

export type QuotasMap = Record<string, QuotaMetric>;

/** Whether an optional Cloudflare product is subscribed on the account. */
export type ServiceActivationStatus = 'activated' | 'not_activated' | 'unknown';

export interface ServiceStatusMap {
  r2?: ServiceActivationStatus;
}

/** Per-metric push notification rule for an account */
export interface AccountAlertRule {
  metricKey: string;
  enabled: boolean;
  thresholdPercent: number;
}

/** @deprecated Legacy shape — migrated to alertRules on read */
export interface AccountAlertSettings {
  enabled: boolean;
  thresholdPercent: number;
  metrics: string[];
}

export interface AccountConfig {
  id: string;
  name: string;
  accountId: string;
  apiToken: string;
  enabled: boolean;
  /** Selected notification channel for this account's alerts */
  notificationChannelId?: string;
  alertRules?: AccountAlertRule[];
  /** @deprecated use alertRules */
  alerts?: AccountAlertSettings;
}

export interface AccountSnapshot {
  accountId: string;
  accountName: string;
  status: 'ok' | 'error';
  error?: string;
  quotas: QuotasMap;
  /** Per-product subscription state (e.g. R2 not enabled on account). */
  serviceStatus?: ServiceStatusMap;
  /** ISO timestamp of last successful quota fetch for this account */
  lastCheckTime?: string;
}

export interface RefreshStats {
  refreshed: number;
  failed: number;
  cached: number;
  skippedByLimit: number;
  subrequestsUsed: number;
}

export interface QuotaSnapshot {
  lastUpdated: string;
  accounts: AccountSnapshot[];
}

export interface FreeTierLimitDef {
  limit: number;
  period: QuotaPeriod;
  unit: string;
  label: string;
}

export type FreeTierLimitsConfig = Record<string, FreeTierLimitDef>;

export type ChannelType =
  | 'wecom'
  | 'feishu'
  | 'dingtalk'
  | 'webhook'
  | 'telegram'
  | 'email';

export interface NotificationChannel {
  id: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
}

export interface PublicNotificationChannel {
  id: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
}

export interface AlertItem {
  account: string;
  accountId: string;
  metricKey: string;
  metric: QuotaMetric;
  thresholdPercent: number;
}

export interface AlertMessage {
  title: string;
  content: string;
  markdown: string;
  alerts: AlertItem[];
  threshold: number;
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

export interface Env {
  KV: KVNamespace;
  ASSETS: Fetcher;
  WEBHOOK_URL?: string;
  ALERT_THRESHOLD?: string;
  FREE_TIER_LIMITS?: string;
  /** Admin login code (single secret credential) */
  PASSWORD?: string;
  /** Internal session username label (default: admin); not shown on login UI */
  USERNAME?: string;
  /** Optional public snapshot API token (defaults to HMAC of PASSWORD+USERNAME) */
  PUBLIC_API_TOKEN?: string;
  /** Skip account refresh if checked within this many minutes (default: 20) */
  ACCOUNT_CHECK_INTERVAL_MINUTES?: string;
  /** Max Cloudflare API subrequests per refresh run (default: 50, cap: 50) */
  MAX_EXTERNAL_SUBREQUESTS_PER_RUN?: string;
  /** Optional CORS allowed origin (defaults to same-origin only) */
  ALLOWED_ORIGIN?: string;
}

export interface QuotaFetchResult extends QuotaSnapshot {
  alerted?: boolean;
  refreshStats: RefreshStats;
}

/** GET /api/snapshot response — may include stale-while-revalidate flags */
export interface SnapshotResponse extends Omit<QuotaSnapshot, 'lastUpdated'> {
  lastUpdated: string | null;
  stale: boolean;
  refreshing?: boolean;
  refreshStats?: RefreshStats;
  alerted?: boolean;
}

export interface PublicAccount {
  id: string;
  name: string;
  accountId: string;
  enabled: boolean;
  apiToken: string;
  notificationChannelId?: string;
  /** Resolved channel name; omitted when unset or invalid */
  notificationChannelName?: string;
  /** True when notificationChannelId references a missing or disabled channel */
  notificationChannelInvalid?: boolean;
  alertRules?: AccountAlertRule[];
}

/** KV-persisted cooldown to avoid duplicate push alerts */
export interface AlertCooldownEntry {
  pct: number;
  at: string;
}

export type AlertCooldownState = Record<string, AlertCooldownEntry>;

/** Admin-editable dashboard settings stored in KV */
export interface DashboardConfig {
  /** Minimum minutes between quota API fetches per account (default: 20) */
  refreshIntervalMinutes: number;
}

export interface PublicDashboardConfig {
  refreshIntervalMinutes: number;
}

export interface FetchResult {
  quotas: QuotasMap;
  status: 'ok' | 'error';
  error?: string;
}

