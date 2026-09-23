import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';

// pdf-parse has no proper types — use require
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse: any = require('pdf-parse');

export interface CbeReceipt {
  referenceNumber: string;
  mobileReceiptId?: string;
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
  reason?: string;
  status: 'success' | 'not_found' | 'failed';
  source: 'sms' | 'pdf' | 'html' | 'none';
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
    Accept: 'text/html,application/xhtml+xml,application/pdf,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  validateStatus: () => true,
  maxRedirects: 5,
});

const DEBUG_DIR = './debug-receipts';
function saveDebug(tag: string, content: string | Buffer) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const safe = tag.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
    fs.writeFileSync(path.join(DEBUG_DIR, safe), content);
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------
// Input classification
// ---------------------------------------------------------------

export type CbeInput =
  | { kind: 'sms'; text: string }
  | { kind: 'reference'; reference: string; suffix?: string }
  | { kind: 'url'; url: string };

export function classifyInput(raw: string, suffix?: string): CbeInput {
  const t = raw.trim();
  if (/^https?:\/\//i.test(t)) return { kind: 'url', url: t };
  if (
    /Dear\s+.+You have successfully transferred/i.test(t) ||
    /Thanks for Banking with CBE/i.test(t) ||
    /has been debited from/i.test(t)
  ) {
    return { kind: 'sms', text: t };
  }
  if (/^FT[A-Z0-9]{6,}$/i.test(t)) return { kind: 'reference', reference: t, suffix };
  return { kind: 'reference', reference: t, suffix };
}

// ---------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------

export async function fetchCbeReceipt(input: string, accountSuffix?: string): Promise<CbeReceipt> {
  const classified = classifyInput(input, accountSuffix);
  switch (classified.kind) {
    case 'sms':
      return fetchFromSms(classified.text);
    case 'reference':
      return fetchFromReference(classified.reference, classified.suffix);
    case 'url':
      return fetchFromUrl(classified.url, input);
  }
}

// ---------------------------------------------------------------
// SMS path
// ---------------------------------------------------------------

export function parseCbeSms(text: string): CbeReceipt {
  const flat = text.replace(/\s+/g, ' ').trim();

  const result: CbeReceipt = {
    referenceNumber: '',
    status: 'success',
    source: 'sms',
    currency: 'ETB',
  };

  const urlMatch = flat.match(/https:\/\/mbreciept\.cbe\.com\.et\/v2-([A-Za-z0-9_-]+)/i);
  if (urlMatch) {
    result.mobileReceiptId = urlMatch[1];
    result.referenceNumber = urlMatch[1];
  }

  const amt = flat.match(/transferred\s+ETB\s*([\d,]+\.?\d*)/i);
  if (amt) result.amount = parseAmount(amt[1]);

  const senderAcc = flat.match(/from account\s+(\S+)/i);
  if (senderAcc) result.payerAccount = senderAcc[1];

  const senderName = flat.match(/^Dear\s+([A-Za-z][A-Za-z\s]+?)\s+You have/i);
  if (senderName) result.payerName = senderName[1].trim();

  const toMatch = flat.match(/to account\s+(\S+)\s*(?:\(([^)]+)\))?/i);
  if (toMatch) {
    result.receiverAccount = toMatch[1];
    if (toMatch[2]) result.receiverName = toMatch[2].trim();
  }

  const sc = flat.match(/Service charge of ETB\s*([\d,]+\.?\d*)/i);
  if (sc) result.serviceCharge = parseAmount(sc[1]);

  const vat = flat.match(/VAT\(?\d*%?\)?\s*of\s*ETB\s*([\d,]+\.?\d*)/i);
  if (vat) result.vat = parseAmount(vat[1]);

  const total = flat.match(/with total of ETB\s*([\d,]+\.?\d*)/i);
  if (total) result.totalAmount = parseAmount(total[1]);

  const bal = flat.match(/current balance is ETB\s*([\d,]+\.?\d*)/i);
  if (bal) result.currentBalance = parseAmount(bal[1]);

  const meaningful = [result.amount, result.receiverAccount, result.receiverName].filter(Boolean).length;
  if (meaningful < 2) {
    return { referenceNumber: result.referenceNumber, status: 'not_found', source: 'sms' };
  }
  return result;
}

// Extend interface (used by SMS for balance)
declare module './cbeScraper' {
  // augmentation only for typing — no runtime effect
}

async function fetchFromSms(text: string): Promise<CbeReceipt> {
  const smsResult = parseCbeSms(text);
  if (smsResult.status === 'success') return smsResult;

  const urlMatch =
    text.match(/https:\/\/mbreciept\.cbe\.com\.et\/v2-[A-Za-z0-9_-]+/i) ||
    text.match(/https:\/\/apps\.cbe\.com\.et[^\s]+/i);

  if (urlMatch) {
    try {
      const urlResult = await fetchFromUrl(urlMatch[0], smsResult.referenceNumber);
      if (urlResult.status === 'success') return urlResult;
    } catch { /* ignore */ }
  }
  return smsResult;
}

// ---------------------------------------------------------------
// Reference + suffix path
// ---------------------------------------------------------------

async function fetchFromReference(reference: string, suffix?: string): Promise<CbeReceipt> {
  const cleanRef = reference.trim().toUpperCase();
  const cleanSuffix = suffix?.trim() ?? '';
  const candidates: string[] = [];

  if (cleanSuffix) {
    candidates.push(`${env.cbeReceiptBase}?id=${encodeURIComponent(cleanRef + cleanSuffix)}`);
    candidates.push(
      `${env.cbeReceiptBase}?id=${encodeURIComponent(cleanRef)}&suffix=${encodeURIComponent(cleanSuffix)}`,
    );
  }
  candidates.push(`${env.cbeReceiptBase}?id=${encodeURIComponent(cleanRef)}`);

  let lastError = '';
  for (const url of candidates) {
    try {
      const r = await fetchAndParse(url, cleanRef);
      if (r.status === 'success') return r;
      if (r.error) lastError = r.error;
    } catch (e: any) {
      lastError = e?.message ?? 'Unknown error';
    }
  }

  return {
    referenceNumber: cleanRef,
    status: 'not_found',
    source: 'none',
    error: lastError || 'No receipt found for this reference',
  };
}

async function fetchFromUrl(url: string, fallbackRef: string): Promise<CbeReceipt> {
  const mobileId = url.match(/\/v2-([A-Za-z0-9_-]+)/i)?.[1];
  return fetchAndParse(url, mobileId || fallbackRef);
}

// ---------------------------------------------------------------
// Universal fetcher
// ---------------------------------------------------------------

async function fetchAndParse(url: string, referenceNumber: string): Promise<CbeReceipt> {
  try {
    const res = await http.get(url, { responseType: 'arraybuffer' });

    if (res.status >= 400) {
      return {
        referenceNumber,
        status: 'not_found',
        source: 'none',
        error: `HTTP ${res.status}`,
      };
    }

    const buffer = Buffer.from(res.data);
    const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
    saveDebug(`fetch_${referenceNumber}.bin`, buffer);

    if (contentType.includes('pdf') || buffer.slice(0, 5).toString() === '%PDF-') {
      return parsePdfReceipt(buffer, referenceNumber);
    }

    const html = buffer.toString('utf-8');
    if (html.length < 50) {
      return { referenceNumber, status: 'not_found', source: 'none' };
    }

    const $ = cheerio.load(html);
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    saveDebug(`html_text_${referenceNumber}.txt`, bodyText);

    const narrative = parseCbeNarrative(bodyText);
    if (narrative.status === 'success') return narrative;

    const smsStyle = parseCbeSms(bodyText);
    if (smsStyle.status === 'success') return { ...smsStyle, source: 'html' };

    return {
      referenceNumber,
      status: 'not_found',
      source: 'none',
      error: `Received ${buffer.length} bytes but no receipt data recognized`,
    };
  } catch (e: any) {
    saveDebug(`fetch_err_${referenceNumber}.txt`, String(e?.stack ?? e));
    return {
      referenceNumber,
      status: 'failed',
      source: 'none',
      error: e?.message ?? 'Fetch failed',
    };
  }
}

// ---------------------------------------------------------------
// PDF parser
// ---------------------------------------------------------------

async function parsePdfReceipt(buffer: Buffer, referenceNumber: string): Promise<CbeReceipt> {
  try {
    const data = await pdfParse(buffer);
    const text = String(data.text ?? '').replace(/\s+/g, ' ').trim();
    saveDebug(`pdf_text_${referenceNumber}.txt`, text);

    // ===== PRIMARY: CBE-specific PDF parser =====
    const cbeSpecific = parseCbePdfReceipt(text, referenceNumber);
    if (cbeSpecific.status === 'success') return cbeSpecific;

    // ===== Fallbacks =====
    const narrative = parseCbeNarrative(text);
    if (narrative.status === 'success') return { ...narrative, source: 'pdf' };

    const smsStyle = parseCbeSms(text);
    if (smsStyle.status === 'success') return { ...smsStyle, source: 'pdf' };

    return {
      referenceNumber,
      status: 'not_found',
      source: 'pdf',
      error: 'PDF parsed but no transaction data found',
    };
  } catch (e: any) {
    saveDebug(`pdf_err_${referenceNumber}.txt`, String(e?.stack ?? e));
    return {
      referenceNumber,
      status: 'failed',
      source: 'pdf',
      error: `PDF parse error: ${e?.message ?? 'unknown'}`,
    };
  }
}

// ---------------------------------------------------------------
// CBE PDF parser — exact match against CBE receipt layout
// ---------------------------------------------------------------
//
// Real CBE PDF text looks like:
//   "Payment / Transaction Information
//    PayerMr Abdulmejid Sehab Mohammed Account1****8064
//    ReceiverDAGIM DESALEGN Account1****7333
//    Payment Date & Time9/19/2026, 6:49:00 PM
//    Reference No. (VAT Invoice No)FT26262VQ6GV
//    Reason / Type of serviceMB Transfer
//    Transferred Amount3,000.00 ETB
//    Commission or Service Charge0.00 ETB
//    15% VAT on Commission0.00 ETB
//    Total amount debited from customers account3,000.00 ETB
//    Amount in Word ETB Three Thousand & Zero cents ..."
//
// Labels and values are glued together — no space, no colon.

function parseCbePdfReceipt(text: string, fallbackRef: string): CbeReceipt {
  // Restrict to the "Payment / Transaction Information" section (skip customer info)
  const paymentSection =
    text.split(/Payment\s*\/\s*Transaction\s*Information/i)[1] ?? text;

  const pick = (re: RegExp): string | undefined => {
    const m = paymentSection.match(re);
    return m && m[1] ? m[1].trim() : undefined;
  };

  // --- Payer / Receiver / Accounts ---
  // "PayerMr Abdulmejid Sehab Mohammed Account1****8064 Receiver..."
  const payerMatch = paymentSection.match(
    /Payer\s*(.+?)\s*Account\s*([\d*]+)\s*Receiver/i,
  );
  const receiverMatch = paymentSection.match(
    /Receiver\s*(.+?)\s*Account\s*([\d*]+)\s*(?:Payment\s*Date|Reference)/i,
  );

  // --- Date ---
  const dateMatch = pick(
    /Payment\s*Date\s*&\s*Time\s*([\d]{1,2}\/[\d]{1,2}\/[\d]{2,4},?\s*[\d:]+\s*(?:AM|PM|am|pm)?)/i,
  );

  // --- Reference ---
  const refMatch = pick(/Reference\s*No\.?\s*(?:\(VAT Invoice No\))?\s*(FT[A-Z0-9]{6,})/i);

  // --- Reason ---
  const reasonMatch = pick(
    /Reason\s*\/\s*Type of service\s*(.+?)(?=\s*Transferred Amount)/i,
  );

  // --- Amounts ---
  const amountMatch = pick(/Transferred\s*Amount\s*([\d,]+\.?\d*)\s*ETB/i);
  const serviceChargeMatch = pick(
    /Commission\s*or\s*Service\s*Charge\s*([\d,]+\.?\d*)\s*ETB/i,
  );
  const vatMatch = pick(/\d+%\s*VAT\s*on\s*Commission\s*([\d,]+\.?\d*)\s*ETB/i);
  const totalMatch = pick(
    /Total\s*amount\s*debited\s*from\s*customers?\s*account\s*([\d,]+\.?\d*)\s*ETB/i,
  );

  // --- Clean names ---
  const cleanName = (s?: string): string | undefined => {
    if (!s) return undefined;
    const c = s
      .replace(/^(Mr|Mrs|Ms|Dr|Prof|Eng)\.?\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    return c.length >= 2 ? c : undefined;
  };

  const payerName = cleanName(payerMatch?.[1]);
  const payerAccount = payerMatch?.[2]?.trim();
  const receiverName = cleanName(receiverMatch?.[1]);
  const receiverAccount = receiverMatch?.[2]?.trim();
  const referenceNumber = refMatch ?? fallbackRef;

  // Require at least 2 fields for success
  const meaningful = [
    payerName,
    receiverName,
    payerAccount,
    receiverAccount,
    amountMatch,
    referenceNumber,
  ].filter(Boolean).length;

  if (meaningful < 3) {
    return { referenceNumber: fallbackRef, status: 'not_found', source: 'pdf' };
  }

  return {
    referenceNumber,
    payerName,
    payerAccount,
    receiverName,
    receiverAccount,
    amount: amountMatch ? parseAmount(amountMatch) : undefined,
    serviceCharge: serviceChargeMatch ? parseAmount(serviceChargeMatch) : undefined,
    vat: vatMatch ? parseAmount(vatMatch) : undefined,
    totalAmount: totalMatch ? parseAmount(totalMatch) : undefined,
    currency: 'ETB',
    date: dateMatch,
    reason: reasonMatch,
    status: 'success',
    source: 'pdf',
  };
}

// ---------------------------------------------------------------
// Narrative pattern (legacy HTML receipts)
// ---------------------------------------------------------------

function parseCbeNarrative(text: string): CbeReceipt {
  const pattern =
    /ETB\s+([\d,]+\.?\d*)\s+has been debited from\s+(.+?)\s+ETB-?\s*(\d+)\s+for\s+(.+?)\s+ETB-?\s*(\d+)\s+on\s+(.+?)\s+with transaction ID:?\s*([A-Z0-9]+)/i;
  const m = text.match(pattern);
  if (!m) return { referenceNumber: '', status: 'not_found', source: 'none' };

  const reasonMatch = text.match(/Reason:\s*(.+?)(?:\.|Total Amount|Service Charge|$)/i);

  return {
    referenceNumber: m[7],
    payerName: m[2].trim(),
    payerAccount: m[3],
    receiverName: m[4].trim(),
    receiverAccount: m[5],
    amount: parseAmount(m[1]),
    currency: 'ETB',
    date: m[6].trim(),
    reason: reasonMatch?.[1]?.trim(),
    status: 'success',
    source: 'html',
  };
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function parseAmount(s: string): number | undefined {
  const cleaned = s.replace(/[^\d.,-]/g, '').replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}