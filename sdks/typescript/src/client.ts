import {
  ClientOptions,
  VerifyOptions,
  VerifyResponse,
  CreateApiKeyOptions,
  ApiKey,
  CbeVerifyError,
  CbeVerifyNetworkError,
} from './types';

const DEFAULT_BASE = 'http://localhost:3000';
const DEFAULT_TIMEOUT = 35000;
const DEFAULT_RETRIES = 3;
const DEFAULT_POLL_INTERVAL = 2000;
const DEFAULT_MAX_POLLS = 20;

export class CbeVerifyClient {
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;
  private pollIntervalMs: number;
  private maxPollAttempts: number;

  constructor(opts: ClientOptions) {
    if (!opts.apiKey) throw new Error('apiKey is required');
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    this.maxRetries = opts.maxRetries ?? DEFAULT_RETRIES;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL;
    this.maxPollAttempts = opts.maxPollAttempts ?? DEFAULT_MAX_POLLS;
  }

  async verify(opts: VerifyOptions): Promise<VerifyResponse> {
    const waitMs = opts.waitMs ?? 30000;
    const url = this.baseUrl + '/api/verify?waitMs=' + waitMs;
    const headers: Record<string, string> = {};
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

    const body: any = {
      bank: opts.bank,
      referenceNumber: opts.referenceNumber,
    };
    if (opts.accountSuffix) body.accountSuffix = opts.accountSuffix;
    if (opts.webhookUrl) body.webhookUrl = opts.webhookUrl;

    const res = await this.request('POST', url, body, headers);
    if (res.status === 200) return res.body as VerifyResponse;

    if (res.status === 202 && res.body && res.body.statusUrl) {
      return this.pollUntilDone(res.body.statusUrl, res.body);
    }

    throw new CbeVerifyError('Unexpected status ' + res.status, res.status, res.body);
  }

  private async pollUntilDone(statusUrl: string, initial: any): Promise<VerifyResponse> {
    const url = statusUrl.startsWith('http') ? statusUrl : this.baseUrl + statusUrl;
    for (let i = 0; i < this.maxPollAttempts; i++) {
      await sleep(this.pollIntervalMs);
      const res = await this.request('GET', url);
      if (res.status !== 200) continue;
      const ps = res.body && res.body.data && res.body.data.processingStatus;
      if (ps === 'completed' || ps === 'failed') {
        return {
          success: true,
          message: 'Verification completed.',
          data: [res.body.data],
          requestId: res.body.data.requestId,
          verification: res.body.data,
          links: { statusUrl },
        };
      }
    }
    throw new CbeVerifyError('Verification did not complete in time', 408, initial);
  }

  async createApiKey(opts: CreateApiKeyOptions = {}): Promise<ApiKey> {
    const res = await this.request('POST', this.baseUrl + '/api/api-keys', opts);
    if (res.status !== 201) {
      throw new CbeVerifyError((res.body && res.body.message) || 'Create key failed', res.status, res.body);
    }
    return res.body.data as ApiKey;
  }

  async listApiKeys(): Promise<ApiKey[]> {
    const res = await this.request('GET', this.baseUrl + '/api/api-keys');
    if (res.status !== 200) {
      throw new CbeVerifyError((res.body && res.body.message) || 'List keys failed', res.status, res.body);
    }
    return res.body.data as ApiKey[];
  }

  async revokeApiKey(id: string): Promise<void> {
    const res = await this.request('DELETE', this.baseUrl + '/api/api-keys/' + id);
    if (res.status !== 200) {
      throw new CbeVerifyError((res.body && res.body.message) || 'Revoke failed', res.status, res.body);
    }
  }

  async history(limit = 50): Promise<any[]> {
    const res = await this.request('GET', this.baseUrl + '/api/verify/history?limit=' + limit);
    return (res.body && res.body.data) || [];
  }

  private async request(
    method: string,
    url: string,
    body?: any,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    let lastErr: any;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = {
          'x-api-key': this.apiKey,
          'content-type': 'application/json',
          'user-agent': 'cbe-verify-sdk-ts/1.0.0',
          ...extraHeaders,
        };
        const res = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timer);
        const text = await res.text();
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
          lastErr = new CbeVerifyError((parsed && parsed.message) || ('HTTP ' + res.status), res.status, parsed);
          await sleep(500 * Math.pow(2, attempt));
          continue;
        }
        return { status: res.status, body: parsed };
      } catch (e: any) {
        clearTimeout(timer);
        lastErr = new CbeVerifyNetworkError((e && e.message) || 'Network error', e);
        if (attempt < this.maxRetries) {
          await sleep(500 * Math.pow(2, attempt));
          continue;
        }
      }
    }
    throw lastErr || new Error('Request failed');
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
