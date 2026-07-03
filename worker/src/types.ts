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

export interface AccountConfig {
  id: string;
  name: string;
  accountId: string;
  apiToken: string;
  enabled: boolean;
}

export interface AccountSnapshot {
  accountId: string;
  accountName: string;
  status: 'ok' | 'error';
  error?: string;
  quotas: QuotasMap;
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
  metric: QuotaMetric;
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
  /** Required for admin write ops in production */
  PASSWORD?: string;
  /** Admin username (default: admin) */
  USERNAME?: string;
  /** Optional public snapshot API token (defaults to HMAC of PASSWORD+USERNAME) */
  PUBLIC_API_TOKEN?: string;
  /** Skip account refresh if checked within this many minutes (default: 20) */
  ACCOUNT_CHECK_INTERVAL_MINUTES?: string;
  /** Max Cloudflare API subrequests per cron/manual run (default: 50, cap: 50) */
  MAX_EXTERNAL_SUBREQUESTS_PER_RUN?: string;
}

export interface QuotaFetchResult extends QuotaSnapshot {
  alerted?: boolean;
  refreshStats: RefreshStats;
}

export interface PublicAccount {
  id: string;
  name: string;
  accountId: string;
  enabled: boolean;
  apiToken: string;
}

export interface FetchResult {
  quotas: QuotasMap;
  status: 'ok' | 'error';
  error?: string;
}
