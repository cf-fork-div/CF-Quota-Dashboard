import type { Context, Next } from 'hono';
import type { Env } from './types';

const SESSION_PREFIX = 'session:';
export const SESSION_COOKIE = 'cfqd_session';
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

const LOGIN_ATTEMPTS_PREFIX = 'LOGIN_ATTEMPTS:';
const MAX_LOGIN_FAILURES = 5;
const LOGIN_WINDOW_SECONDS = 15 * 60;

interface SessionData {
  username: string;
  createdAt: number;
}

interface LoginAttemptState {
  failures: number;
  firstFailureAt: number;
}

export function isAuthConfigured(env: Env): boolean {
  return Boolean(env.PASSWORD?.trim());
}

export function getAdminUsername(env: Env): string {
  return env.USERNAME?.trim() || 'admin';
}

export async function createSession(
  kv: KVNamespace,
  username: string,
): Promise<string> {
  const token = crypto.randomUUID();
  const data: SessionData = { username, createdAt: Date.now() };
  await kv.put(`${SESSION_PREFIX}${token}`, JSON.stringify(data), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return token;
}

export async function validateSession(
  kv: KVNamespace,
  token: string,
): Promise<SessionData | null> {
  if (!token) return null;
  const raw = await kv.get(`${SESSION_PREFIX}${token}`, 'json');
  if (!raw || typeof raw !== 'object') return null;
  return raw as SessionData;
}

export async function deleteSession(
  kv: KVNamespace,
  token: string,
): Promise<void> {
  if (token) await kv.delete(`${SESSION_PREFIX}${token}`);
}

export function parseSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=') || null;
  }
  return null;
}

export function buildSessionCookie(token: string, maxAge = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

export function buildClearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export async function derivePublicApiToken(env: Env): Promise<string | null> {
  const password = env.PASSWORD?.trim();
  if (!password) return null;
  const username = getAdminUsername(env);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`public-api:${username}`),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function getPublicApiToken(env: Env): Promise<string | null> {
  const explicit = env.PUBLIC_API_TOKEN?.trim();
  if (explicit) return explicit;
  return derivePublicApiToken(env);
}

async function sha256Hex(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export async function verifyPassword(submitted: string, expected: string): Promise<boolean> {
  if (!submitted || !expected) return false;
  const [submittedHash, expectedHash] = await Promise.all([
    sha256Hex(submitted),
    sha256Hex(expected),
  ]);
  return timingSafeEqual(submittedHash, expectedHash);
}

export function getClientIp(c: Context<{ Bindings: Env }>): string {
  return c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'anonymous';
}

export async function checkLoginRateLimit(
  kv: KVNamespace,
  ip: string,
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const raw = await kv.get(`${LOGIN_ATTEMPTS_PREFIX}${ip}`, 'json');
  if (!raw || typeof raw !== 'object') return { allowed: true };

  const state = raw as LoginAttemptState;
  const windowMs = LOGIN_WINDOW_SECONDS * 1000;
  const elapsed = Date.now() - state.firstFailureAt;

  if (elapsed >= windowMs) {
    return { allowed: true };
  }

  if (state.failures >= MAX_LOGIN_FAILURES) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((windowMs - elapsed) / 1000),
    };
  }

  return { allowed: true };
}

export async function recordLoginFailure(kv: KVNamespace, ip: string): Promise<void> {
  const key = `${LOGIN_ATTEMPTS_PREFIX}${ip}`;
  const raw = await kv.get(key, 'json');
  const now = Date.now();
  const windowMs = LOGIN_WINDOW_SECONDS * 1000;

  let state: LoginAttemptState;
  if (raw && typeof raw === 'object') {
    const existing = raw as LoginAttemptState;
    if (now - existing.firstFailureAt >= windowMs) {
      state = { failures: 1, firstFailureAt: now };
    } else {
      state = { failures: existing.failures + 1, firstFailureAt: existing.firstFailureAt };
    }
  } else {
    state = { failures: 1, firstFailureAt: now };
  }

  await kv.put(key, JSON.stringify(state), { expirationTtl: LOGIN_WINDOW_SECONDS });
}

export async function clearLoginAttempts(kv: KVNamespace, ip: string): Promise<void> {
  await kv.delete(`${LOGIN_ATTEMPTS_PREFIX}${ip}`);
}

export async function requireAuth(c: Context<{ Bindings: Env }>, next: Next) {
  if (!isAuthConfigured(c.env)) {
    return c.json({ error: 'Auth not configured' }, 503);
  }

  const token = parseSessionCookie(c.req.header('Cookie'));
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const session = await validateSession(c.env.KV, token);
  if (!session) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  return next();
}

export function sanitizeRedirectPath(raw: string | null | undefined): string {
  if (!raw || typeof raw !== 'string') return '/admin';
  const path = raw.trim();
  if (!path.startsWith('/') || path.startsWith('//')) return '/admin';
  if (path.includes('\\') || path.includes('\0')) return '/admin';
  try {
    const decoded = decodeURIComponent(path);
    if (decoded.startsWith('//') || decoded.includes('://')) return '/admin';
  } catch {
    return '/admin';
  }
  return path;
}
