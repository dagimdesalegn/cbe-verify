import axios, { AxiosInstance } from 'axios';
import https from 'node:https';
import { env } from '../config/env';

export interface MpesaReceipt {
  referenceNumber: string;
  payerName?: string;
  payerPhone?: string;
  receiverName?: string;
  receiverPhone?: string;
  receiverAccount?: string;
  amount?: number;
  serviceCharge?: number;
  currency?: string;
  date?: string;
  status: 'success' | 'not_found' | 'failed';
  source: 'sms' | 'none';
  geoBlocked?: boolean;
  error?: string;
}

const httpsAgent = env.cbeAllowInsecureTls
  ? new https.Agent({ rejectUnauthorized: false })
  : undefined;

// M-Pesa receipt URL is a Next.js SPA. The receipt itself is a PDF loaded by
// JavaScript after page load, so a plain HTTP fetch returns only scripts.
// We accept SMS-text input as the reliable path.

export type MpesaInput =
  | { kind: 'sms'; text: string }
  | { kind: 'reference'; reference: string }
  | { kind: 'url'; url: string };

export function classifyMpesaInput(raw: string): MpesaInput {
  const t = raw.trim();
  if (/^https?:\/\//i.test(t)) return { kind: 'url', url: t };
  if (/ልከዋል|M-PESA ቀሪ|transaction id|You have transferred/i.test(t)) {
    return { kind: 'sms', text: t };
  }
  return { kind: 'reference', reference: t };
}

export async function fetchMpesaReceipt(input: string): Promise<MpesaReceipt> {
  const c = classifyMpesaInput(input);
  if (c.kind === 'sms') return parseMpesaSms(c.text);

  // For URL or bare reference, extract the ref and try SMS-style parse;
  // if that fails, tell the user to paste the SMS instead.
  const refMatch =
    c.kind === 'url'
      ? c.url.match(/\/receipt\/([A-Z0-9]+)/i)
      : null;
  const reference = refMatch ? refMatch[1] : c.kind === 'reference' ? c.reference : input;

  return {
    referenceNumber: reference,
    status: 'failed',
    source: 'none',
    error:
      'M-Pesa receipt pages are JavaScript-rendered SPAs — no data available via HTTP. ' +
      'Please submit the M-Pesa confirmation SMS text instead (paste the full SMS from 127).',
  };
}

// -------------------------------------------------------------
// SMS parser (works offline, has full data)
// -------------------------------------------------------------

export function parseMpesaSms(text: string): MpesaReceipt {
  const flat = text.replace(/\s+/g, ' ').trim();
  const result: MpesaReceipt = {
    referenceNumber: '',
    status: 'success',
    source: 'sms',
    currency: 'ETB',
  };

  // Transaction ID: "መለያ ቁጥር UIO6P2QVDY" or "transaction id ... UIO6P2QVDY"
  const tx = flat.match(/(?:transaction\s+id|መለያ\s+ቁጥር)[^\w]*([A-Z0-9]{10})/i);
  if (tx) result.referenceNumber = tx[1];
  if (!result.referenceNumber) {
    const urlMatch = flat.match(/https:\/\/m-pesabusiness\.safaricom\.et\/receipt\/([A-Z0-9]+)/i);
    if (urlMatch) result.referenceNumber = urlMatch[1];
  }

  // Amount: "1.00 ብር ለ..." or "ETB 1.00"
  const amt =
    flat.match(/([\d,]+\.?\d*)\s*ብር\s*(?:ለ|to)/i) ||
    flat.match(/ETB\s*([\d,]+\.?\d*)/i);
  if (amt) result.amount = parseAmount(amt[1]);

  // Receiver: "ለ X 251712***789"
  const toMatch = flat.match(/ለ\s*([A-Za-z\s]+?)\s*(\d{6}\*+\d{3})/i);
  if (toMatch) {
    result.receiverName = toMatch[1].trim();
    result.receiverPhone = toMatch[2];
  }

  // Service charge: "የአገልግሎት ክፍያ 0.00 ብር"
  const fee = flat.match(/የአገልግሎት\s*ክፍያ\s*([\d,]+\.?\d*)/i);
  if (fee) result.serviceCharge = parseAmount(fee[1]);

  // Date: "24/9/26 በ8:56 AM"
  const dt = flat.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s*በ(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
  if (dt) result.date = dt[1] + ' ' + dt[2];

  const meaningful = [result.referenceNumber, result.amount, result.receiverName].filter(Boolean).length;
  if (meaningful < 2) {
    return { referenceNumber: result.referenceNumber, status: 'not_found', source: 'sms' };
  }
  return result;
}

function parseAmount(s: string): number | undefined {
  if (!s) return undefined;
  const cleaned = s.replace(/[^\d.,-]/g, '').replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}