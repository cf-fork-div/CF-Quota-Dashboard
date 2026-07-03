import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type {
  AccountConfig,
  AccountSnapshot,
  ChannelType,
  Env,
  NotificationChannel,
  QuotaFetchResult,
  RefreshStats,
} from './types';
import {
  addChannel,
  deleteChannel,
  generateId,
  getAccounts,
  getChannelById,
  getChannels,
  getSnapshot,
  maskAccount,
  maskChannel,
  saveAccounts,
  saveSnapshot,
  toggleChannel,
  updateAccount,
  updateChannel,
} from './kv-store';
import { fetchAccountQuotas, SUBREQUESTS_PER_ACCOUNT, verifyAccountCredentials } from './fetcher';
import { getAlertThreshold } from './free-tier-limits';
import { sendQuotaAlert, sendTestNotification } from './notifier';
import {
  buildClearSessionCookie,
  buildSessionCookie,
  createSession,
  deleteSession,
  getAdminUsername,
  getPublicApiToken,
  isAuthConfigured,
  parseSessionCookie,
  requireAuth,
  validateSession,
} from './auth';

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors({ credentials: true, origin: (origin) => origin ?? '*' }));

function getCheckIntervalMinutes(env: Env): number {
  const parsed = parseInt(env.ACCOUNT_CHECK_INTERVAL_MINUTES ?? '20', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
}

function getMaxSubrequests(env: Env): number {
  const parsed = parseInt(env.MAX_EXTERNAL_SUBREQUESTS_PER_RUN ?? '50', 10);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
  return Math.min(50, value);
}

app.get('/api/me', async (c) => {
  if (!isAuthConfigured(c.env)) {
    return c.json({ authenticated: false, authEnabled: false, devMode: true });
  }

  const token = parseSessionCookie(c.req.header('Cookie'));
  if (!token) {
    return c.json({ authenticated: false, authEnabled: true });
  }

  const session = await validateSession(c.env.KV, token);
  if (!session) {
    return c.json({ authenticated: false, authEnabled: true });
  }

  return c.json({
    authenticated: true,
    authEnabled: true,
    username: session.username,
  });
});

app.post('/api/login', async (c) => {
  if (!isAuthConfigured(c.env)) {
    return c.json({ error: 'Auth not configured. Set PASSWORD in Worker vars.' }, 503);
  }

  const body = await c.req.json<{ username?: string; password?: string }>();
  const expectedUser = getAdminUsername(c.env);
  const expectedPass = c.env.PASSWORD!.trim();

  if (body.username !== expectedUser || body.password !== expectedPass) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const sessionToken = await createSession(c.env.KV, expectedUser);
  c.header('Set-Cookie', buildSessionCookie(sessionToken));
  return c.json({ ok: true, username: expectedUser });
});

app.post('/api/logout', async (c) => {
  const token = parseSessionCookie(c.req.header('Cookie'));
  if (token) await deleteSession(c.env.KV, token);
  c.header('Set-Cookie', buildClearSessionCookie());
  return c.json({ ok: true });
});

app.get('/api/public/snapshot', async (c) => {
  const expected = await getPublicApiToken(c.env);
  if (!expected) {
    return c.json({ error: 'Public API not configured' }, 503);
  }

  const token = c.req.query('token');
  if (!token || token !== expected) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const snapshot = await getSnapshot(c.env.KV);
  return c.json(snapshot ?? { lastUpdated: null, accounts: [] });
});

app.get('/api/public/token', requireAuth, async (c) => {
  const token = await getPublicApiToken(c.env);
  if (!token) {
    return c.json({ error: 'Set PASSWORD or PUBLIC_API_TOKEN to enable public API' }, 503);
  }
  return c.json({ token, hint: 'Use GET /api/public/snapshot?token=...' });
});

app.get('/api/accounts', async (c) => {
  const accounts = await getAccounts(c.env.KV);
  return c.json(accounts.map(maskAccount));
});

app.post('/api/accounts', requireAuth, async (c) => {
  const body = await c.req.json<{
    name?: string;
    accountId?: string;
    apiToken?: string;
    enabled?: boolean;
  }>();

  if (!body.name?.trim() || !body.accountId?.trim() || !body.apiToken?.trim()) {
    return c.json({ error: 'name, accountId, and apiToken are required' }, 400);
  }

  const accounts = await getAccounts(c.env.KV);
  const account: AccountConfig = {
    id: generateId(),
    name: body.name.trim(),
    accountId: body.accountId.trim(),
    apiToken: body.apiToken.trim(),
    enabled: body.enabled !== false,
  };
  accounts.push(account);
  await saveAccounts(c.env.KV, accounts);
  return c.json(maskAccount(account), 201);
});

app.post('/api/accounts/verify', requireAuth, async (c) => {
  const body = await c.req.json<{ accountId?: string; apiToken?: string }>();
  if (!body.accountId?.trim() || !body.apiToken?.trim()) {
    return c.json({ error: 'accountId and apiToken are required' }, 400);
  }

  const result = await verifyAccountCredentials(body.apiToken.trim(), body.accountId.trim());
  if (!result.ok) {
    return c.json({ ok: false, error: result.error }, 400);
  }
  return c.json({ ok: true, accountName: result.accountName });
});

app.put('/api/accounts/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Account id required' }, 400);
  const body = await c.req.json<{
    name?: string;
    accountId?: string;
    apiToken?: string;
    enabled?: boolean;
  }>();

  const updated = await updateAccount(c.env.KV, id, {
    name: body.name,
    accountId: body.accountId,
    apiToken: body.apiToken,
    enabled: body.enabled,
  });

  if (!updated) return c.json({ error: 'Account not found' }, 404);
  return c.json(maskAccount(updated));
});

app.delete('/api/accounts/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  const accounts = await getAccounts(c.env.KV);
  const next = accounts.filter((a) => a.id !== id);
  if (next.length === accounts.length) {
    return c.json({ error: 'Account not found' }, 404);
  }
  await saveAccounts(c.env.KV, next);
  return c.json({ ok: true });
});

app.get('/api/snapshot', async (c) => {
  const snapshot = await getSnapshot(c.env.KV);
  return c.json(snapshot ?? { lastUpdated: null, accounts: [] });
});

const VALID_CHANNEL_TYPES: ChannelType[] = [
  'wecom',
  'feishu',
  'dingtalk',
  'webhook',
  'telegram',
  'email',
];

function validateChannelBody(body: {
  type?: string;
  name?: string;
  enabled?: boolean;
  config?: Record<string, string>;
}): string | null {
  if (!body.name?.trim()) return 'name is required';
  if (!body.type || !VALID_CHANNEL_TYPES.includes(body.type as ChannelType)) {
    return 'type must be one of: wecom, feishu, dingtalk, webhook, telegram, email';
  }
  if (!body.config || typeof body.config !== 'object') return 'config is required';
  return null;
}

app.get('/api/channels', async (c) => {
  const channels = await getChannels(c.env.KV);
  return c.json(channels.map(maskChannel));
});

app.post('/api/channels', requireAuth, async (c) => {
  const body = await c.req.json<{
    type?: ChannelType;
    name?: string;
    enabled?: boolean;
    config?: Record<string, string>;
  }>();

  const error = validateChannelBody(body);
  if (error) return c.json({ error }, 400);

  const channel: NotificationChannel = {
    id: generateId(),
    type: body.type as ChannelType,
    name: body.name!.trim(),
    enabled: body.enabled !== false,
    config: body.config!,
  };

  await addChannel(c.env.KV, channel);
  return c.json(maskChannel(channel), 201);
});

app.put('/api/channels/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Channel id required' }, 400);
  const body = await c.req.json<{
    name?: string;
    enabled?: boolean;
    config?: Record<string, string>;
  }>();

  const updated = await updateChannel(c.env.KV, id, {
    name: body.name,
    enabled: body.enabled,
    config: body.config,
  });

  if (!updated) return c.json({ error: 'Channel not found' }, 404);
  return c.json(maskChannel(updated));
});

app.delete('/api/channels/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Channel id required' }, 400);
  const deleted = await deleteChannel(c.env.KV, id);
  if (!deleted) return c.json({ error: 'Channel not found' }, 404);
  return c.json({ ok: true });
});

app.patch('/api/channels/:id/toggle', requireAuth, async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Channel id required' }, 400);
  const channel = await toggleChannel(c.env.KV, id);
  if (!channel) return c.json({ error: 'Channel not found' }, 404);
  return c.json(maskChannel(channel));
});

app.post('/api/channels/:id/test', requireAuth, async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Channel id required' }, 400);
  const channel = await getChannelById(c.env.KV, id);
  if (!channel) return c.json({ error: 'Channel not found' }, 404);

  const result = await sendTestNotification(channel);
  if (!result.ok) return c.json({ ok: false, error: result.error }, 502);
  return c.json({ ok: true });
});

app.post('/cron/fetch', requireAuth, async (c) => {
  const result = await runQuotaFetch(c.env);
  return c.json(result);
});

export async function runQuotaFetch(env: Env): Promise<QuotaFetchResult> {
  const accounts = (await getAccounts(env.KV)).filter((a) => a.enabled);
  const previousSnapshot = await getSnapshot(env.KV);
  const limitsJson = env.FREE_TIER_LIMITS;

  const intervalMs = getCheckIntervalMinutes(env) * 60 * 1000;
  const maxSubrequests = getMaxSubrequests(env);
  const now = Date.now();

  const existingByAccountId = new Map<string, AccountSnapshot>(
    (previousSnapshot?.accounts ?? []).map((a) => [a.accountId, a]),
  );

  const stats: RefreshStats = {
    refreshed: 0,
    failed: 0,
    cached: 0,
    skippedByLimit: 0,
    subrequestsUsed: 0,
  };

  const sortedAccounts = [...accounts].sort((a, b) => {
    const ta = existingByAccountId.get(a.accountId)?.lastCheckTime;
    const tb = existingByAccountId.get(b.accountId)?.lastCheckTime;
    const timeA = ta ? new Date(ta).getTime() : 0;
    const timeB = tb ? new Date(tb).getTime() : 0;
    return timeA - timeB;
  });

  const refreshedByAccountId = new Map<string, AccountSnapshot>();

  for (const account of sortedAccounts) {
    const cached = existingByAccountId.get(account.accountId);
    const lastCheckTime = cached?.lastCheckTime;

    if (lastCheckTime) {
      const elapsed = now - new Date(lastCheckTime).getTime();
      if (elapsed < intervalMs) {
        refreshedByAccountId.set(account.accountId, cached!);
        stats.cached++;
        continue;
      }
    }

    if (stats.subrequestsUsed + SUBREQUESTS_PER_ACCOUNT > maxSubrequests) {
      if (cached) {
        refreshedByAccountId.set(account.accountId, cached);
      } else {
        refreshedByAccountId.set(account.accountId, {
          accountId: account.accountId,
          accountName: account.name,
          status: 'error',
          error: 'Skipped: subrequest budget exhausted',
          quotas: {},
        });
      }
      stats.skippedByLimit++;
      continue;
    }

    const snapshot = await fetchAccountQuotas(
      account.apiToken,
      account.accountId,
      account.name,
      limitsJson,
    );
    stats.subrequestsUsed += SUBREQUESTS_PER_ACCOUNT;

    if (snapshot.status === 'ok') stats.refreshed++;
    else stats.failed++;

    refreshedByAccountId.set(account.accountId, snapshot);
  }

  const accountSnapshots: AccountSnapshot[] = accounts.map((a) => {
    const snap = refreshedByAccountId.get(a.accountId);
    if (snap) return snap;
    return (
      existingByAccountId.get(a.accountId) ?? {
        accountId: a.accountId,
        accountName: a.name,
        status: 'error' as const,
        error: 'Not yet fetched',
        quotas: {},
      }
    );
  });

  const snapshot: QuotaFetchResult = {
    lastUpdated: new Date().toISOString(),
    accounts: accountSnapshots,
    refreshStats: stats,
  };

  await saveSnapshot(env.KV, snapshot);

  const threshold = getAlertThreshold(env.ALERT_THRESHOLD);
  const alerted = await sendQuotaAlert(env, accountSnapshots, threshold);

  return { ...snapshot, alerted };
}

app.get('*', async (c) => {
  const url = new URL(c.req.url);
  let path = url.pathname;
  if (path === '/admin') path = '/admin.html';
  if (path === '/channels') path = '/channels.html';
  if (path === '/login') path = '/login.html';
  if (path === '/') path = '/index.html';
  const asset = await c.env.ASSETS.fetch(new URL(path, c.req.url));
  if (asset.status === 404) {
    return c.text('Not Found', 404);
  }
  return asset;
});

export default {
  fetch: app.fetch,
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runQuotaFetch(env));
  },
};
