import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type {
  AccountAlertRule,
  AccountConfig,
  AccountSnapshot,
  ChannelType,
  Env,
  NotificationChannel,
  QuotaFetchResult,
  RefreshStats,
  SnapshotResponse,
} from './types';
import { ALERT_SERVICE_GROUPS, normalizeAlertRules, validateAccountAlertConfig } from './account-alerts';
import {
  addChannel,
  checkAlertTestRateLimit,
  deleteChannel,
  generateId,
  getAccounts,
  getChannelById,
  getChannels,
  getDashboardConfig,
  getSnapshot,
  markAlertTestSent,
  maskAccount,
  maskChannel,
  reorderAccounts,
  saveAccounts,
  saveDashboardConfig,
  saveSnapshot,
  sortSnapshotsByAccountOrder,
  toggleChannel,
  tryAcquireSnapshotRefreshLock,
  updateAccount,
  updateChannel,
  ALLOWED_REFRESH_INTERVALS,
  DEFAULT_REFRESH_INTERVAL_MINUTES,
} from './kv-store';
import { fetchAccountQuotas, SUBREQUESTS_PER_ACCOUNT, verifyAccountCredentials } from './fetcher';
import { getAlertThreshold } from './free-tier-limits';
import { sendQuotaAlert, sendTestAlerts, sendTestNotification } from './notifier';
import {
  buildClearSessionCookie,
  buildSessionCookie,
  checkLoginRateLimit,
  clearLoginAttempts,
  createSession,
  deleteSession,
  getAdminUsername,
  getClientIp,
  getPublicApiToken,
  isAuthConfigured,
  parseSessionCookie,
  recordLoginFailure,
  requireAuth,
  validateSession,
  verifyPassword,
} from './auth';

const app = new Hono<{ Bindings: Env }>();

function resolveCorsOrigin(env: Env, requestOrigin: string | undefined, requestUrl: string): string | null {
  const allowed = env.ALLOWED_ORIGIN?.trim();
  if (allowed) {
    return requestOrigin === allowed ? allowed : null;
  }
  if (!requestOrigin) return null;
  const url = new URL(requestUrl);
  const sameOrigin = `${url.protocol}//${url.host}`;
  return requestOrigin === sameOrigin ? requestOrigin : null;
}

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header(
    'Content-Security-Policy-Report-Only',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:",
  );
});

app.use('/api/*', async (c, next) => {
  const origin = c.req.header('Origin');
  const allowedOrigin = resolveCorsOrigin(c.env, origin, c.req.url);
  if (origin && !allowedOrigin) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  return cors({
    credentials: true,
    origin: allowedOrigin ?? '',
  })(c, next);
});

async function getCheckIntervalMinutes(env: Env): Promise<number> {
  const config = await getDashboardConfig(env.KV);
  if (config.refreshIntervalMinutes > 0) {
    return config.refreshIntervalMinutes;
  }

  const parsed = parseInt(env.ACCOUNT_CHECK_INTERVAL_MINUTES ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REFRESH_INTERVAL_MINUTES;
}

function isSnapshotStale(lastUpdated: string | null | undefined, intervalMinutes: number): boolean {
  if (!lastUpdated) return true;
  const elapsed = Date.now() - new Date(lastUpdated).getTime();
  return elapsed >= intervalMinutes * 60 * 1000;
}

async function getSnapshotWithOptionalRefresh(
  env: Env,
  ctx: { waitUntil: (promise: Promise<unknown>) => void },
  options?: { force?: boolean },
): Promise<SnapshotResponse> {
  const snapshot = await getSnapshot(env.KV);
  const intervalMinutes = await getCheckIntervalMinutes(env);
  const stale = isSnapshotStale(snapshot?.lastUpdated, intervalMinutes);
  const hasCachedData = Boolean(snapshot?.lastUpdated && snapshot.accounts?.length);

  if (options?.force) {
    const result = await runQuotaFetch(env, { force: true });
    return { ...result, stale: false, refreshing: false };
  }

  if (hasCachedData) {
    if (stale) {
      const canRefresh = await tryAcquireSnapshotRefreshLock(env.KV);
      if (canRefresh) {
        ctx.waitUntil(runQuotaFetch(env, { force: true }));
        return { ...snapshot!, stale: true, refreshing: true };
      }
      return { ...snapshot!, stale: true, refreshing: false };
    }
    return { ...snapshot!, stale: false, refreshing: false };
  }

  const enabledAccounts = (await getAccounts(env.KV)).filter((a) => a.enabled);
  if (enabledAccounts.length === 0) {
    return { lastUpdated: snapshot?.lastUpdated ?? null, accounts: [], stale: true, refreshing: false };
  }

  const result = await runQuotaFetch(env, { force: true });
  return { ...result, stale: false, refreshing: false };
}

function scheduleQuotaRefresh(
  env: Env,
  ctx: { waitUntil: (promise: Promise<unknown>) => void },
): void {
  ctx.waitUntil(runQuotaFetch(env, { force: true }));
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

  const clientIp = getClientIp(c);
  const rateLimit = await checkLoginRateLimit(c.env.KV, clientIp);
  if (!rateLimit.allowed) {
    return c.json(
      { error: 'Too many login attempts', retryAfterSeconds: rateLimit.retryAfterSeconds },
      429,
    );
  }

  const body = await c.req.json<{ password?: string }>();
  const expectedPass = c.env.PASSWORD!.trim();
  const submitted = body.password?.trim() ?? '';

  const valid = await verifyPassword(submitted, expectedPass);
  if (!valid) {
    await recordLoginFailure(c.env.KV, clientIp);
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  await clearLoginAttempts(c.env.KV, clientIp);
  const sessionToken = await createSession(c.env.KV, getAdminUsername(c.env));
  c.header('Set-Cookie', buildSessionCookie(sessionToken));
  return c.json({ ok: true, username: getAdminUsername(c.env) });
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

  const snapshot = await getSnapshotWithOptionalRefresh(c.env, c.executionCtx);
  const accounts = await getAccounts(c.env.KV);
  if (snapshot.accounts?.length && accounts.length) {
    snapshot.accounts = sortSnapshotsByAccountOrder(snapshot.accounts, accounts);
  }
  return c.json(snapshot);
});

app.get('/api/public/token', requireAuth, async (c) => {
  const token = await getPublicApiToken(c.env);
  if (!token) {
    return c.json({ error: 'Set PASSWORD or PUBLIC_API_TOKEN to enable public API' }, 503);
  }
  return c.json({ token, hint: 'Use GET /api/public/snapshot?token=...' });
});

app.get('/api/accounts', requireAuth, async (c) => {
  const threshold = getAlertThreshold(c.env.ALERT_THRESHOLD);
  const [accounts, channels] = await Promise.all([
    getAccounts(c.env.KV),
    getChannels(c.env.KV),
  ]);
  return c.json(accounts.map((a) => maskAccount(a, threshold, channels)));
});

app.get('/api/alert-service-groups', async (c) => {
  return c.json({
    groups: ALERT_SERVICE_GROUPS.map(({ id, title, keys }) => ({ id, title, keys })),
    defaultThresholdPercent: 80,
  });
});

app.post('/api/accounts', requireAuth, async (c) => {
  const body = await c.req.json<{
    name?: string;
    accountId?: string;
    apiToken?: string;
    enabled?: boolean;
    alertRules?: AccountAlertRule[];
    notificationChannelId?: string;
  }>();

  if (!body.name?.trim() || !body.accountId?.trim() || !body.apiToken?.trim()) {
    return c.json({ error: 'name, accountId, and apiToken are required' }, 400);
  }

  const threshold = getAlertThreshold(c.env.ALERT_THRESHOLD);
  const channels = await getChannels(c.env.KV);
  const alertValidation = validateAccountAlertConfig(
    body.alertRules,
    body.notificationChannelId,
    channels,
    threshold,
  );
  if (!alertValidation.ok) {
    return c.json({ error: alertValidation.error }, 400);
  }

  const alertRules = normalizeAlertRules(body.alertRules, undefined, threshold);
  const accounts = await getAccounts(c.env.KV);
  const account: AccountConfig = {
    id: generateId(),
    name: body.name.trim(),
    accountId: body.accountId.trim(),
    apiToken: body.apiToken.trim(),
    enabled: body.enabled !== false,
    notificationChannelId: alertValidation.notificationChannelId,
    alertRules: alertRules.length ? alertRules : undefined,
  };
  accounts.push(account);
  await saveAccounts(c.env.KV, accounts);
  scheduleQuotaRefresh(c.env, c.executionCtx);
  return c.json(maskAccount(account, threshold, channels), 201);
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

app.put('/api/accounts/reorder', requireAuth, async (c) => {
  const body = await c.req.json<{ accountIds?: string[] }>();
  if (!body.accountIds || !Array.isArray(body.accountIds) || body.accountIds.length === 0) {
    return c.json({ error: 'accountIds array is required' }, 400);
  }

  const reordered = await reorderAccounts(c.env.KV, body.accountIds);
  if (!reordered) {
    return c.json({ error: 'accountIds must include every configured account exactly once' }, 400);
  }

  const snapshot = await getSnapshot(c.env.KV);
  if (snapshot?.accounts?.length) {
    snapshot.accounts = sortSnapshotsByAccountOrder(snapshot.accounts, reordered);
    await saveSnapshot(c.env.KV, snapshot);
  }

  const threshold = getAlertThreshold(c.env.ALERT_THRESHOLD);
  const channels = await getChannels(c.env.KV);
  return c.json(reordered.map((a) => maskAccount(a, threshold, channels)));
});

app.put('/api/accounts/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Account id required' }, 400);
  const body = await c.req.json<{
    name?: string;
    accountId?: string;
    apiToken?: string;
    enabled?: boolean;
    alertRules?: AccountAlertRule[];
    notificationChannelId?: string;
  }>();

  const threshold = getAlertThreshold(c.env.ALERT_THRESHOLD);
  const existingAccounts = await getAccounts(c.env.KV);
  const existing = existingAccounts.find((a) => a.id === id);
  if (!existing) return c.json({ error: 'Account not found' }, 404);

  const channels = await getChannels(c.env.KV);
  const alertFieldsTouched =
    body.alertRules !== undefined || body.notificationChannelId !== undefined;

  let notificationChannelId = existing.notificationChannelId;
  if (alertFieldsTouched) {
    const alertRulesInput = body.alertRules !== undefined ? body.alertRules : existing.alertRules;
    const channelIdInput =
      body.notificationChannelId !== undefined
        ? body.notificationChannelId
        : existing.notificationChannelId;

    const alertValidation = validateAccountAlertConfig(
      alertRulesInput,
      channelIdInput,
      channels,
      threshold,
    );
    if (!alertValidation.ok) {
      return c.json({ error: alertValidation.error }, 400);
    }
    notificationChannelId = alertValidation.notificationChannelId;
  }

  const updates: Parameters<typeof updateAccount>[2] = {
    name: body.name,
    accountId: body.accountId,
    apiToken: body.apiToken,
    enabled: body.enabled,
  };
  if (body.alertRules !== undefined) updates.alertRules = body.alertRules;
  if (alertFieldsTouched) updates.notificationChannelId = notificationChannelId;

  const updated = await updateAccount(c.env.KV, id, updates, threshold);

  if (!updated) return c.json({ error: 'Account not found' }, 404);

  const quotaAffecting =
    body.enabled !== undefined || body.accountId !== undefined || body.apiToken !== undefined;
  if (quotaAffecting) {
    scheduleQuotaRefresh(c.env, c.executionCtx);
  }

  return c.json(maskAccount(updated, threshold, channels));
});

app.delete('/api/accounts/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  const accounts = await getAccounts(c.env.KV);
  const next = accounts.filter((a) => a.id !== id);
  if (next.length === accounts.length) {
    return c.json({ error: 'Account not found' }, 404);
  }
  await saveAccounts(c.env.KV, next);
  scheduleQuotaRefresh(c.env, c.executionCtx);
  return c.json({ ok: true });
});

app.get('/api/snapshot', async (c) => {
  const snapshot = await getSnapshotWithOptionalRefresh(c.env, c.executionCtx);
  const accounts = await getAccounts(c.env.KV);
  if (snapshot.accounts?.length && accounts.length) {
    snapshot.accounts = sortSnapshotsByAccountOrder(snapshot.accounts, accounts);
  }
  return c.json(snapshot);
});

app.get('/api/config', async (c) => {
  const config = await getDashboardConfig(c.env.KV);
  return c.json({
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    allowedIntervals: [...ALLOWED_REFRESH_INTERVALS],
    defaultIntervalMinutes: DEFAULT_REFRESH_INTERVAL_MINUTES,
  });
});

app.put('/api/config', requireAuth, async (c) => {
  const body = await c.req.json<{ refreshIntervalMinutes?: number }>();
  if (body.refreshIntervalMinutes === undefined) {
    return c.json({ error: 'refreshIntervalMinutes is required' }, 400);
  }

  const parsed = parseInt(String(body.refreshIntervalMinutes), 10);
  if (!(ALLOWED_REFRESH_INTERVALS as readonly number[]).includes(parsed)) {
    return c.json(
      {
        error: `refreshIntervalMinutes must be one of: ${ALLOWED_REFRESH_INTERVALS.join(', ')}`,
      },
      400,
    );
  }

  const config = await saveDashboardConfig(c.env.KV, { refreshIntervalMinutes: parsed });
  return c.json({
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    allowedIntervals: [...ALLOWED_REFRESH_INTERVALS],
    defaultIntervalMinutes: DEFAULT_REFRESH_INTERVAL_MINUTES,
  });
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

app.get('/api/channels', requireAuth, async (c) => {
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

function getAlertTestRateLimitKey(c: { req: { header: (name: string) => string | undefined } }): string {
  const token = parseSessionCookie(c.req.header('Cookie'));
  if (token) return `session:${token}`;
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'anonymous';
  return `ip:${ip}`;
}

app.post('/api/alerts/test', requireAuth, async (c) => {
  try {
    const rateLimitKey = getAlertTestRateLimitKey(c);
    const rateLimit = await checkAlertTestRateLimit(c.env.KV, rateLimitKey);
    if (!rateLimit.allowed) {
      return c.json(
        {
          error: '测试告警发送过于频繁，请稍后再试',
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        },
        429,
      );
    }

    let body: { accountId?: string } = {};
    try {
      body = await c.req.json<{ accountId?: string }>();
    } catch {
      // empty body is fine
    }

    let accountName: string | undefined;
    if (body.accountId?.trim()) {
      const accounts = await getAccounts(c.env.KV);
      const account = accounts.find(
        (a) => a.id === body.accountId || a.accountId === body.accountId,
      );
      if (account) accountName = account.name;
    }

    const channels = await getChannels(c.env.KV);
    const enabledCount = channels.filter((ch) => ch.enabled).length;
    const legacyUrl = c.env.WEBHOOK_URL?.trim();
    if (enabledCount === 0 && !legacyUrl) {
      return c.json({ error: '未配置已启用的通知渠道，请先在「通知渠道」页面添加并启用' }, 400);
    }

    const result = await sendTestAlerts(c.env, accountName ? { accountName } : undefined);
    await markAlertTestSent(c.env.KV, rateLimitKey);

    const successCount = result.channels.filter((ch) => ch.ok).length;
    const failCount = result.channels.length - successCount;

    return c.json({
      ok: result.sent,
      sent: result.sent,
      accountName: accountName ?? null,
      channels: result.channels,
      message: result.sent
        ? `测试告警已发送（${successCount}/${result.channels.length} 个渠道成功${failCount ? `，${failCount} 个失败` : ''}）`
        : '所有通知渠道发送失败，请检查渠道配置',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '服务器错误';
    return c.json({ error: message }, 500);
  }
});

app.post('/api/channels/:id/test', requireAuth, async (c) => {
  try {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'Channel id required' }, 400);
    const channel = await getChannelById(c.env.KV, id);
    if (!channel) return c.json({ error: 'Channel not found' }, 404);

    const rateLimitKey = `${getAlertTestRateLimitKey(c)}:channel:${id}`;
    const rateLimit = await checkAlertTestRateLimit(c.env.KV, rateLimitKey);
    if (!rateLimit.allowed) {
      return c.json(
        {
          error: '测试发送过于频繁，请稍后再试',
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        },
        429,
      );
    }

    const result = await sendTestNotification(channel);
    await markAlertTestSent(c.env.KV, rateLimitKey);
    if (!result.ok) return c.json({ ok: false, error: result.error }, 502);
    return c.json({ ok: true, message: '测试消息已发送' });
  } catch (err) {
    const message = err instanceof Error ? err.message : '服务器错误';
    return c.json({ error: message }, 500);
  }
});

app.post('/cron/fetch', requireAuth, async (c) => {
  const result = await runQuotaFetch(c.env, { force: true });
  return c.json(result);
});

export async function runQuotaFetch(env: Env, options?: { force?: boolean }): Promise<QuotaFetchResult> {
  const accounts = (await getAccounts(env.KV)).filter((a) => a.enabled);
  const previousSnapshot = await getSnapshot(env.KV);
  const limitsJson = env.FREE_TIER_LIMITS;

  const intervalMs = (await getCheckIntervalMinutes(env)) * 60 * 1000;
  const maxSubrequests = getMaxSubrequests(env);
  const force = options?.force === true;
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

    if (!force && lastCheckTime) {
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

  const allAccounts = await getAccounts(env.KV);
  const alerted = await sendQuotaAlert(env, accountSnapshots, allAccounts);

  return { ...snapshot, alerted };
}

app.get('*', async (c) => {
  const url = new URL(c.req.url);
  let path = url.pathname;
  if (path === '/admin') path = '/admin.html';
  if (path === '/admin/settings') path = '/admin/settings.html';
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
