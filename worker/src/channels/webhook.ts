import type { AlertMessage, SendResult } from '../types';
import { sanitizeCustomHeaders, validateOutboundUrl } from '../url-validation';

export async function sendWebhook(
  config: Record<string, string>,
  message: AlertMessage,
): Promise<SendResult> {
  const webhookUrl = config.webhookUrl?.trim();
  if (!webhookUrl) return { ok: false, error: 'webhookUrl is required' };

  const urlCheck = validateOutboundUrl(webhookUrl);
  if (!urlCheck.ok) return { ok: false, error: urlCheck.error };

  const body = {
    title: message.title,
    content: message.content,
    markdown: message.markdown,
    threshold: message.threshold,
    alerts: message.alerts.map(({ account, metric }) => ({
      account,
      label: metric.label,
      used: metric.used,
      limit: metric.limit,
      pct: metric.pct,
      unit: metric.unit,
      period: metric.period,
    })),
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.customHeaders?.trim()) {
    try {
      const custom = JSON.parse(config.customHeaders) as Record<string, string>;
      const sanitized = sanitizeCustomHeaders(custom);
      if (sanitized.error) {
        return { ok: false, error: sanitized.error };
      }
      Object.assign(headers, sanitized.headers);
    } catch {
      return { ok: false, error: 'customHeaders must be valid JSON' };
    }
  }

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Request failed' };
  }
}
