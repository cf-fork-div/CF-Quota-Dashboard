import type { AlertMessage, SendResult } from '../types';

/**
 * Email via webhook relay (Resend, Mailgun, custom mail API, etc.).
 * Workers cannot use SMTP directly; users provide an HTTP endpoint that sends email.
 */
export async function sendEmail(
  config: Record<string, string>,
  message: AlertMessage,
): Promise<SendResult> {
  const webhookUrl = config.webhookUrl?.trim();
  const to = config.to?.trim();
  if (!webhookUrl) return { ok: false, error: 'webhookUrl is required' };
  if (!to) return { ok: false, error: 'to is required' };

  const body = {
    to,
    subject: message.title,
    text: message.content,
    html: message.markdown.replace(/\n/g, '<br>'),
    markdown: message.markdown,
  };

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
