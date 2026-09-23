import axios from 'axios';
import crypto from 'node:crypto';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const BACKOFF_MS = [0, 30_000, 120_000, 480_000, 1_800_000];

export async function deliverWebhook(url: string, payload: any) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = env.webhookSigningSecret
    ? 'sha256=' +
      crypto
        .createHmac('sha256', env.webhookSigningSecret)
        .update(`${timestamp}.${body}`)
        .digest('hex')
    : undefined;

  for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
    try {
      await axios.post(url, body, {
        timeout: 30_000,
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Event': payload?.event ?? 'verification.completed',
          'X-Webhook-Delivery-Id': crypto.randomUUID(),
          'X-Webhook-Timestamp': timestamp,
          ...(signature ? { 'X-Webhook-Signature': signature } : {}),
        },
      });
      logger.info({ url, attempt }, 'webhook delivered');
      return;
    } catch (err: any) {
      logger.warn({ err: err?.message, url, attempt }, 'webhook attempt failed');
      if (attempt < BACKOFF_MS.length - 1) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
      }
    }
  }
  logger.error({ url }, 'webhook permanently failed');
}