import type { AlertMessage, ChannelType, NotificationChannel, SendResult } from '../types';
import { sendDingtalk } from './dingtalk';
import { sendEmail } from './email';
import { sendFeishu } from './feishu';
import { sendTelegram } from './telegram';
import { sendWebhook } from './webhook';
import { sendWecom } from './wecom';

export async function sendToChannel(
  channel: NotificationChannel,
  message: AlertMessage,
): Promise<SendResult> {
  return sendByType(channel.type, channel.config, message);
}

export async function sendByType(
  type: ChannelType,
  config: Record<string, string>,
  message: AlertMessage,
): Promise<SendResult> {
  switch (type) {
    case 'wecom':
      return sendWecom(config, message);
    case 'dingtalk':
      return sendDingtalk(config, message);
    case 'feishu':
      return sendFeishu(config, message);
    case 'webhook':
      return sendWebhook(config, message);
    case 'telegram':
      return sendTelegram(config, message);
    case 'email':
      return sendEmail(config, message);
    default:
      return { ok: false, error: `Unknown channel type: ${type}` };
  }
}
