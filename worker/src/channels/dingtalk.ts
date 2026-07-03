import type { AlertMessage, SendResult } from '../types';

export async function sendDingtalk(
  config: Record<string, string>,
  message: AlertMessage,
): Promise<SendResult> {
  const webhookUrl = config.webhookUrl?.trim();
  if (!webhookUrl) return { ok: false, error: 'webhookUrl is required' };

  const body = {
    msgtype: 'markdown',
    markdown: {
      title: message.title,
      text: message.markdown,
    },
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
