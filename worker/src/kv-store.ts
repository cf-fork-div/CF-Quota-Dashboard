import type {
  AccountConfig,
  NotificationChannel,
  PublicAccount,
  PublicNotificationChannel,
  QuotaSnapshot,
} from './types';

const ACCOUNTS_KEY = 'ACCOUNTS';
const SNAPSHOT_KEY = 'QUOTA_SNAPSHOT';
const CHANNELS_KEY = 'NOTIFICATION_CHANNELS';

const SENSITIVE_CONFIG_KEYS = new Set([
  'webhookUrl',
  'botToken',
  'chatId',
  'customHeaders',
]);

export async function getAccounts(kv: KVNamespace): Promise<AccountConfig[]> {
  const raw = await kv.get(ACCOUNTS_KEY, 'json');
  if (!raw || !Array.isArray(raw)) return [];
  return raw as AccountConfig[];
}

export async function saveAccounts(
  kv: KVNamespace,
  accounts: AccountConfig[],
): Promise<void> {
  await kv.put(ACCOUNTS_KEY, JSON.stringify(accounts));
}

export async function updateAccount(
  kv: KVNamespace,
  id: string,
  updates: Partial<Pick<AccountConfig, 'name' | 'accountId' | 'apiToken' | 'enabled'>>,
): Promise<AccountConfig | null> {
  const accounts = await getAccounts(kv);
  const index = accounts.findIndex((a) => a.id === id);
  if (index === -1) return null;

  const existing = accounts[index];
  let apiToken = existing.apiToken;
  if (updates.apiToken?.trim()) {
    const val = updates.apiToken.trim();
    const isMasked = val.includes('...');
    if (!isMasked) apiToken = val;
  }

  accounts[index] = {
    ...existing,
    name: updates.name?.trim() || existing.name,
    accountId: updates.accountId?.trim() || existing.accountId,
    apiToken,
    enabled: updates.enabled ?? existing.enabled,
  };
  await saveAccounts(kv, accounts);
  return accounts[index];
}

export async function getSnapshot(kv: KVNamespace): Promise<QuotaSnapshot | null> {
  const raw = await kv.get(SNAPSHOT_KEY, 'json');
  if (!raw || typeof raw !== 'object') return null;
  return raw as QuotaSnapshot;
}

export async function saveSnapshot(
  kv: KVNamespace,
  snapshot: QuotaSnapshot,
): Promise<void> {
  await kv.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
}

export function maskAccount(account: AccountConfig): PublicAccount {
  const token = account.apiToken || '';
  const masked =
    token.length <= 8
      ? '****'
      : `${token.slice(0, 4)}...${token.slice(-4)}`;
  return {
    id: account.id,
    name: account.name,
    accountId: account.accountId,
    enabled: account.enabled,
    apiToken: masked,
  };
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function maskConfigValue(key: string, value: string): string {
  if (SENSITIVE_CONFIG_KEYS.has(key)) return maskSecret(value);
  return value;
}

export function maskChannel(channel: NotificationChannel): PublicNotificationChannel {
  const config: Record<string, string> = {};
  for (const [key, value] of Object.entries(channel.config)) {
    config[key] = maskConfigValue(key, value);
  }
  return {
    id: channel.id,
    type: channel.type,
    name: channel.name,
    enabled: channel.enabled,
    config,
  };
}

export async function getChannels(kv: KVNamespace): Promise<NotificationChannel[]> {
  const raw = await kv.get(CHANNELS_KEY, 'json');
  if (!raw || !Array.isArray(raw)) return [];
  return raw as NotificationChannel[];
}

export async function saveChannels(
  kv: KVNamespace,
  channels: NotificationChannel[],
): Promise<void> {
  await kv.put(CHANNELS_KEY, JSON.stringify(channels));
}

export async function addChannel(
  kv: KVNamespace,
  channel: NotificationChannel,
): Promise<NotificationChannel> {
  const channels = await getChannels(kv);
  channels.push(channel);
  await saveChannels(kv, channels);
  return channel;
}

export async function updateChannel(
  kv: KVNamespace,
  id: string,
  updates: Partial<Pick<NotificationChannel, 'name' | 'enabled' | 'config'>>,
): Promise<NotificationChannel | null> {
  const channels = await getChannels(kv);
  const index = channels.findIndex((c) => c.id === id);
  if (index === -1) return null;

  const existing = channels[index];
  const mergedConfig = { ...existing.config };
  if (updates.config) {
    for (const [key, value] of Object.entries(updates.config)) {
      if (!value) continue;
      const isMasked = value.includes('...') && SENSITIVE_CONFIG_KEYS.has(key);
      if (!isMasked) mergedConfig[key] = value;
    }
  }

  channels[index] = {
    ...existing,
    name: updates.name?.trim() || existing.name,
    enabled: updates.enabled ?? existing.enabled,
    config: mergedConfig,
  };
  await saveChannels(kv, channels);
  return channels[index];
}

export async function deleteChannel(
  kv: KVNamespace,
  id: string,
): Promise<boolean> {
  const channels = await getChannels(kv);
  const next = channels.filter((c) => c.id !== id);
  if (next.length === channels.length) return false;
  await saveChannels(kv, next);
  return true;
}

export async function toggleChannel(
  kv: KVNamespace,
  id: string,
): Promise<NotificationChannel | null> {
  const channels = await getChannels(kv);
  const channel = channels.find((c) => c.id === id);
  if (!channel) return null;
  channel.enabled = !channel.enabled;
  await saveChannels(kv, channels);
  return channel;
}

export async function getChannelById(
  kv: KVNamespace,
  id: string,
): Promise<NotificationChannel | null> {
  const channels = await getChannels(kv);
  return channels.find((c) => c.id === id) ?? null;
}
