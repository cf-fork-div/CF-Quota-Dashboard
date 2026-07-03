import type { AlertMessage, SendResult } from '../types';

export async function sendTelegram(
  config: Record<string, string>,
  message: AlertMessage,
): Promise<SendResult> {
  const botToken = config.botToken?.trim();
  const chatId = config.chatId?.trim();
  if (!botToken) return { ok: false, error: 'botToken is required' };
  if (!chatId) return { ok: false, error: 'chatId is required' };

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: message.content,
    parse_mode: 'Markdown',
  };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }
    const data = (await resp.json()) as { ok?: boolean; description?: string };
    if (!data.ok) {
      return { ok: false, error: data.description || 'Telegram API error' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Request failed' };
  }
}
