import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error('Missing env variable: ' + name);
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  adminApiKey: required('ADMIN_API_KEY'),
  cbeReceiptBase: required('CBE_RECEIPT_BASE', 'https://apps.cbe.com.et:100/'),
  cbeMobileReceiptBase: required('CBE_MOBILE_RECEIPT_BASE', 'https://mbreciept.cbe.com.et/'),
  cbeTimeoutMs: Number(process.env.CBE_RECEIPT_TIMEOUT_MS ?? 20000),
  cbeAllowInsecureTls: process.env.CBE_ALLOW_INSECURE_TLS === 'true',
  webhookSigningSecret: process.env.WEBHOOK_SIGNING_SECRET ?? '',
  dbPath: process.env.DB_PATH ?? './data/verify.db',
  // Telebirr â€” geo-blocked to Ethiopian IPs. Set TELEBIRR_PROXY_URL to route via an Ethiopian relay.
  telebirrProxyUrl: process.env.TELEBIRR_PROXY_URL ?? '',
  telebirrProxySecret: process.env.TELEBIRR_PROXY_SECRET ?? '',
  telebirrFetchTimeoutMs: Number(process.env.TELEBIRR_FETCH_TIMEOUT_MS ?? 8000),
};