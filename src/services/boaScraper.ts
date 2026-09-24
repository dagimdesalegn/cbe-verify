import axios, { AxiosInstance } from 'axios';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';

export interface BoaReceipt {
  referenceNumber: string;
  payerName?: string;
  payerAccount?: string;
  receiverName?: string;
  receiverAccount?: string;
  amount?: number;
  serviceCharge?: number;
  vat?: number;
  totalAmount?: number;
  currency?: string;
  date?: string;
  status: 'success' | 'not_found' | 'failed';
  source: 'json' | 'none';
  error?: string;
}

const httpsAgent = env.cbeAllowInsecureTls
  ? new https.Agent({ rejectUnauthorized: false })
  : undefined;

const http: AxiosInstance = axios.create({
  timeout: env.cbeTimeoutMs,
  httpsAgent,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    Accept: 'application/json,*/*',
  },
  validateStatus: () => true,
  maxRedirects: 5,
});

const DEBUG_DIR = './debug-receipts';
function saveDebug(tag: string, content: string) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const safe = tag.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
    fs.writeFileSync(path.join(DEBUG_DIR, safe), content);
  } catch { /* best-effort */ }
}

export async function fetchBoaReceipt(
  reference: string,
  suffix?: string,
): Promise<BoaReceipt> {
  const cleanRef = reference.trim().toUpperCase();
  const cleanSuffix = suffix?.trim() ?? '';

  if (!cleanSuffix || !/^\d{5}$/.test(cleanSuffix)) {
    return {
      referenceNumber: cleanRef,
      status: 'failed',
      source: 'none',
      error: 'Bank of Abyssinia requires a 5-digit account suffix.',
    };
  }

  const fullId = cleanRef + cleanSuffix;
  const jsonUrl = `https://cs.bankofabyssinia.com/api/onlineSlip/getDetails/?id=${encodeURIComponent(fullId)}`;

  try {
    const res = await http.get(jsonUrl);
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    saveDebug(`boa_json_${fullId}.txt`, body);

    if (res.status !== 200) {
      return {
        referenceNumber: cleanRef,
        status: 'not_found',
        source: 'none',
        error: `HTTP ${res.status}`,
      };
    }

    let data: any;
    try {
      data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    } catch {
      return { referenceNumber: cleanRef, status: 'failed', source: 'none', error: 'Invalid JSON' };
    }

    const parsed = parseBoaJson(data, cleanRef);
    return parsed;
  } catch (e: any) {
    saveDebug(`boa_json_err_${fullId}.txt`, String(e?.message ?? e));
    return {
      referenceNumber: cleanRef,
      status: 'failed',
      source: 'none',
      error: e?.message ?? 'Fetch failed',
    };
  }
}

function parseBoaJson(json: any, fallbackRef: string): BoaReceipt {
  // BOA returns: { header: {...}, body: [ { receipt fields } ] }
  const item = Array.isArray(json?.body) ? json.body[0] : json?.body ?? json;
  if (!item || typeof item !== 'object') {
    return { referenceNumber: fallbackRef, status: 'not_found', source: 'none' };
  }

  // Case-insensitive key lookup (BOA uses apostrophes + spaces + % signs)
  const flat: Record<string, any> = {};
  for (const [k, v] of Object.entries(item)) {
    flat[normalize(k)] = v;
  }

  const get = (...keys: string[]): any => {
    for (const k of keys) {
      const v = flat[normalize(k)];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };

  const receipt: BoaReceipt = {
    referenceNumber: String(get('Transaction Reference', 'reference') ?? fallbackRef),
    payerName: asString(get("Payer's Name", 'Source Account Name', 'payerName')),
    payerAccount: asString(get('Source Account', 'payerAccount')),
    receiverName: asString(get("Receiver's Name", 'receiverName')),
    receiverAccount: asString(get("Receiver's Account", 'receiverAccount')),
    amount: asNumber(get('Transferred Amount', 'amount')),
    serviceCharge: asNumber(get('Service Charge', 'serviceCharge')),
    vat: asNumber(get('VAT (15%)', 'VAT', 'vat')),
    totalAmount: asNumber(get('Total Amount including VAT', 'totalAmount', 'Total Amount')),
    currency: asString(get('currency', 'Currency')) ?? 'ETB',
    date: asString(get('Transaction Date', 'date')),
    status: 'success',
    source: 'json',
  };

  const meaningful = [
    receipt.payerName,
    receipt.receiverName,
    receipt.amount,
    receipt.referenceNumber,
  ].filter(Boolean).length;

  if (meaningful < 2) {
    return { referenceNumber: fallbackRef, status: 'not_found', source: 'none' };
  }

  return receipt;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s'’]+/g, ' ').trim();
}
function asString(v: any): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s || undefined;
}
function asNumber(v: any): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}