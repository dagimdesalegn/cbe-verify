import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';

export interface TelebirrReceipt {
  referenceNumber: string;
  payerName?: string;
  payerPhone?: string;
  receiverName?: string;
  receiverPhone?: string;
  receiverAccount?: string;
  amount?: number;
  serviceFee?: number;
  vat?: number;
  totalPaid?: number;
  currentBalance?: number;
  currency?: string;
  date?: string;
  status: 'success' | 'not_found' | 'failed';
  source: 'sms' | 'html' | 'none';
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
    Accept: 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
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

export type TelebirrInput =
  | { kind: 'sms'; text: string }
  | { kind: 'reference'; reference: string }
  | { kind: 'url'; url: string };

export function classifyTelebirrInput(raw: string): TelebirrInput {
  const t = raw.trim();
  if (/^https?:\/\//i.test(t)) return { kind: 'url', url: t };
  if (/You have transferred|Thank you for using telebirr/i.test(t)) {
    return { kind: 'sms', text: t };
  }
  return { kind: 'reference', reference: t };
}

export async function fetchTelebirrReceipt(input: string): Promise<TelebirrReceipt> {
  const classified = classifyTelebirrInput(input);
  switch (classified.kind) {
    case 'sms':
      return fetchFromSms(classified.text);
    case 'reference':
      return fetchFromReference(classified.reference);
    case 'url':
      return fetchFromUrl(classified.url);
  }
}

// -------------------------------------------------------------
// SMS parser
// -------------------------------------------------------------

export function parseTelebirrSms(text: string): TelebirrReceipt {
  const flat = text.replace(/\s+/g, ' ').trim();

  const result: TelebirrReceipt = {
    referenceNumber: '',
    status: 'success',
    source: 'sms',
    currency: 'ETB',
  };

  // Transaction number from text or URL
  const txMatch = flat.match(/transaction number is\s+([A-Z0-9]+)/i);
  if (txMatch) result.referenceNumber = txMatch[1];

  const urlMatch = flat.match(/https:\/\/transactioninfo\.ethiotelecom\.et\/receipt\/([A-Z0-9]+)/i);
  if (urlMatch && !result.referenceNumber) result.referenceNumber = urlMatch[1];

  // Amount
  const amt = flat.match(/transferred\s+ETB\s*([\d,]+\.?\d*)/i);
  if (amt) result.amount = parseAmount(amt[1]);

  // Receiver name and phone
  const toMatch = flat.match(/to\s+(.+?)\s+\((\d{4}\*+\d{4})\)/i);
  if (toMatch) {
    result.receiverName = toMatch[1].trim();
    result.receiverPhone = toMatch[2];
  }

  // Service fee
  const fee = flat.match(/service fee is\s+ETB\s*([\d,]+\.?\d*)/i);
  if (fee) result.serviceFee = parseAmount(fee[1]);

  // VAT
  const vat = flat.match(/VAT on the service fee is ETB\s*([\d,]+\.?\d*)/i);
  if (vat) result.vat = parseAmount(vat[1]);

  // Current balance
  const bal = flat.match(/balance is ETB\s*([\d,]+\.?\d*)/i);
  if (bal) result.currentBalance = parseAmount(bal[1]);

  // Date
  const dateMatch = flat.match(/on\s+(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/i);
  if (dateMatch) result.date = dateMatch[1];

  const meaningful = [result.referenceNumber, result.amount, result.receiverName].filter(Boolean).length;
  if (meaningful < 2) {
    return { referenceNumber: result.referenceNumber, status: 'not_found', source: 'sms' };
  }
  return result;
}

async function fetchFromSms(text: string): Promise<TelebirrReceipt> {
  const smsResult = parseTelebirrSms(text);
  if (smsResult.status === 'success' && smsResult.referenceNumber) {
    // Try to enrich with HTML from the receipt URL
    const urlMatch = text.match(/https:\/\/transactioninfo\.ethiotelecom\.et\/receipt\/[A-Z0-9]+/i);
    if (urlMatch) {
      try {
        const htmlResult = await fetchFromUrl(urlMatch[0]);
        if (htmlResult.status === 'success') {
          const merged: any = { ...smsResult };
          for (const [k, v] of Object.entries(htmlResult)) {
            if (v !== undefined && v !== null) merged[k] = v;
          }
          return merged;
        }
      } catch { /* fall through */ }
    }
    return smsResult;
  }
  return smsResult;
}

// -------------------------------------------------------------
// Reference + URL paths
// -------------------------------------------------------------

async function fetchFromReference(reference: string): Promise<TelebirrReceipt> {
  const cleanRef = reference.trim().toUpperCase();
  const url = 'https://transactioninfo.ethiotelecom.et/receipt/' + encodeURIComponent(cleanRef);
  return fetchFromUrl(url);
}

async function fetchFromUrl(url: string): Promise<TelebirrReceipt> {
  const refMatch = url.match(/\/receipt\/([A-Z0-9]+)/i);
  const referenceNumber = refMatch ? refMatch[1] : url;

  try {
    const res = await http.get(url);
    const html = typeof res.data === 'string' ? res.data : String(res.data ?? '');
    saveDebug('telebirr_' + referenceNumber + '.html', html);

    if (!html || html.length < 100) {
      return {
        referenceNumber,
        status: 'not_found',
        source: 'none',
        error: 'Empty response',
      };
    }

    return parseTelebirrHtml(referenceNumber, html);
  } catch (e: any) {
    saveDebug('telebirr_err_' + referenceNumber + '.txt', String(e?.stack ?? e));
    return {
      referenceNumber,
      status: 'failed',
      source: 'none',
      error: e?.message ?? 'Fetch failed',
    };
  }
}

// -------------------------------------------------------------
// HTML parser
// -------------------------------------------------------------

export function parseTelebirrHtml(referenceNumber: string, html: string): TelebirrReceipt {
  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

  // Check for not-found / error pages
  if (/not found|invalid|no record|does not exist/i.test(bodyText) && bodyText.length < 500) {
    return { referenceNumber, status: 'not_found', source: 'html' };
  }

  const result: TelebirrReceipt = {
    referenceNumber,
    status: 'success',
    source: 'html',
    currency: 'ETB',
  };

  // Strategy 1: label + value pairs across any element
  const fields: Record<string, string> = {};

  $('tr').each((_, row) => {
    const cells = $(row).find('td, th');
    if (cells.length < 2) return;
    const label = normalize($(cells[0]).text());
    const value = clean($(cells[1]).text());
    if (label && value) fields[label] = value;
  });

  if (Object.keys(fields).length === 0) {
    $('div, p, li, span, section').each((_, el) => {
      const t = clean($(el).text());
      const m = t.match(/^([A-Za-z][A-Za-z0-9 /_-]{2,40}?)\s*[:ï¼š]\s*(.+)$/);
      if (m) {
        const k = normalize(m[1]);
        if (!fields[k]) fields[k] = clean(m[2]);
      }
    });
  }

  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = fields[normalize(k)];
      if (v) return v;
    }
    return undefined;
  };

  const amountStr = pick(
    'Amount',
    'Total Paid Amount',
    'Total Amount',
    'Transaction Amount',
    'Settled Amount',
    'Paid Amount',
  );

  const get = (re: RegExp): string | undefined => {
    const m = bodyText.match(re);
    return m && m[1] ? m[1].trim() : undefined;
  };

  result.payerName = pick('Payer Name', 'Sender Name', 'Payer', 'From') ||
    get(/Payer\s*Name[:\s]+([A-Za-z][A-Za-z\s]+?)(?=\s+(?:Payer|Receiver|Credited|Payment|Amount|Invoice|$))/i);
  result.payerPhone = pick('Payer Telebirr No', 'Payer Phone', 'Sender Phone') ||
    get(/Payer\s*Telebirr\s*No[:\s]+(\d{4}\*+\d{4})/i);
  result.receiverName = pick(
    'Credited Party Name',
    'Receiver Name',
    'Beneficiary Name',
    'To',
  ) || get(/Credited\s*Party\s*Name[:\s]+([A-Za-z][A-Za-z\s]+?)(?=\s+(?:Payer|Receiver|Credited|Payment|Amount|Invoice|$))/i);
  result.receiverAccount = pick(
    'Credited Party Account No',
    'Receiver Account',
    'Beneficiary Account',
  ) || get(/Credited\s*Party\s*Account\s*No[:\s]+(\d{4}\*+\d{4})/i);
  result.amount = amountStr ? parseAmount(amountStr) : undefined;
  result.serviceFee = parseAmount(pick('Service Fee', 'Service Charge', 'Fee') ?? '') ?? undefined;
  result.vat = parseAmount(pick('VAT', 'Tax') ?? '') ?? undefined;
  result.totalPaid = parseAmount(pick('Total Paid Amount', 'Total Paid') ?? '') ?? undefined;
  result.currentBalance = parseAmount(pick('Current Balance', 'Balance') ?? '') ?? undefined;
  result.date = pick('Payment Date', 'Transaction Date', 'Date') ||
    get(/Payment\s*Date[:\s]+(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/i);
  result.referenceNumber = pick('Invoice Number', 'Receipt Number', 'Transaction Number') || referenceNumber;

  const meaningful = [result.amount, result.receiverName, result.referenceNumber].filter(Boolean).length;
  if (meaningful < 2) {
    return { referenceNumber, status: 'not_found', source: 'html' };
  }

  return result;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[:ï¼š]\s*$/, '').trim();
}
function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
function parseAmount(s: string): number | undefined {
  if (!s) return undefined;
  const cleaned = s.replace(/[^\d.,-]/g, '').replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}