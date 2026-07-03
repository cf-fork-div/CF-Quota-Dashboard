import type { Context, Next } from 'hono';
import type { Env } from './types';

const SESSION_PREFIX = 'session:';
export const SESSION_COOKIE = 'cfqd_session';
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

interface SessionData {
  username: string;
  createdAt: number;
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

export async function requireAuth(c: Context<{ Bindings: Env }>, next: Next) {
  if (!isAuthConfigured(c.env)) {
    return next();
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
