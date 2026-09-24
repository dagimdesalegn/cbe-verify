export type Bank = 'cbe' | 'telebirr' | 'boa' | 'dashen' | 'mpesa';

export interface VerifyOptions {
  bank: Bank;
  referenceNumber: string;
  accountSuffix?: string;
  webhookUrl?: string;
  waitMs?: number;
  idempotencyKey?: string;
}

export interface VerificationData {
  bank: string;
  status: 'success' | 'failed' | 'not_found';
  verified: boolean;
  amount?: number;
  currency?: string;
  senderName?: string;
  senderAccount?: string;
  receiverName?: string;
  receiverAccount?: string;
  referenceNumber?: string;
  accountSuffix?: string;
  date?: string;
  reason?: string;
  serviceCharge?: number;
  vat?: number;
  totalAmount?: number;
  source?: string;
  geoBlocked?: boolean;
  error?: string;
}

export interface VerifyResponse {
  success: boolean;
  message: string;
  data: VerificationData[];
  requestId: string;
  verification: {
    requestId: string;
    processingStatus: 'queued' | 'running' | 'completed' | 'failed';
    status: string;
    verified: boolean;
  };
  links?: {
    statusUrl?: string;
    pollAfterMs?: number;
    webhookRegistered?: boolean;
  };
}

export interface CreateApiKeyOptions {
  name?: string;
  permissions?: string[];
}

export interface ApiKey {
  id: string;
  key?: string;
  key_prefix?: string;
  name?: string;
  permissions?: string | string[];
  enabled?: number;
  is_admin?: number;
  last_used_at?: string | null;
  request_count?: number;
  created_at?: string;
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

export class CbeVerifyError extends Error {
  status: number;
  body: any;
  constructor(message: string, status: number, body: any) {
    super(message);
    this.name = 'CbeVerifyError';
    this.status = status;
    this.body = body;
  }
}

export class CbeVerifyNetworkError extends Error {
  cause: any;
  constructor(message: string, cause: any) {
    super(message);
    this.name = 'CbeVerifyNetworkError';
    this.cause = cause;
  }
}
