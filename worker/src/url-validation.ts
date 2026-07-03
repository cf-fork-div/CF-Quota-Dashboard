export interface UrlValidationResult {
  ok: boolean;
  error?: string;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  'metadata.google.internal',
  'metadata.goog',
]);

const METADATA_IP_PREFIXES = ['169.254.', '100.64.', '100.65.', '100.66.', '100.67.', '100.68.', '100.69.', '100.70.', '100.71.', '100.72.', '100.73.', '100.74.', '100.75.', '100.76.', '100.77.', '100.78.', '100.79.', '100.80.', '100.81.', '100.82.', '100.83.', '100.84.', '100.85.', '100.86.', '100.87.', '100.88.', '100.89.', '100.90.', '100.91.', '100.92.', '100.93.', '100.94.', '100.95.', '100.96.', '100.97.', '100.98.', '100.99.', '100.100.', '100.101.', '100.102.', '100.103.', '100.104.', '100.105.', '100.106.', '100.107.', '100.108.', '100.109.', '100.110.', '100.111.', '100.112.', '100.113.', '100.114.', '100.115.', '100.116.', '100.117.', '100.118.', '100.119.', '100.120.', '100.121.', '100.122.', '100.123.', '100.124.', '100.125.', '100.126.', '100.127.'];

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (METADATA_IP_PREFIXES.some((prefix) => hostname.startsWith(prefix))) return true;
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe80')) return true;
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lower)) return true;
  if (lower.endsWith('.localhost') || lower.endsWith('.local')) return true;
  if (lower.endsWith('.internal')) return true;
  if (isPrivateIpv4(lower)) return true;
  if (isPrivateIpv6(lower)) return true;
  return false;
}

export function validateOutboundUrl(rawUrl: string): UrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only HTTPS URLs are allowed' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URLs with embedded credentials are not allowed' };
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    return { ok: false, error: 'URL hostname is required' };
  }

  if (isBlockedHostname(hostname)) {
    return { ok: false, error: 'URL targets a blocked or private host' };
  }

  return { ok: true };
}

const FORBIDDEN_HEADER_NAMES = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'cookie',
  'set-cookie',
  'origin',
  'referer',
  'proxy-authorization',
  'proxy-connection',
  'keep-alive',
  'x-forwarded-host',
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',
]);

export function sanitizeCustomHeaders(
  custom: Record<string, string>,
): { headers: Record<string, string>; error?: string } {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(custom)) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      return { headers: {}, error: 'customHeaders values must be strings' };
    }
    const normalized = key.trim();
    if (!normalized) continue;
    if (FORBIDDEN_HEADER_NAMES.has(normalized.toLowerCase())) {
      return { headers: {}, error: `Header "${normalized}" is not allowed` };
    }
    headers[normalized] = value;
  }
  return { headers };
}
