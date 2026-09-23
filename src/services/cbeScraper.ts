import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { Browser } from 'puppeteer';
import { env } from '../config/env';

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
  disasterRecovery?: number;
  totalAmount?: number;
  currentBalance?: number;
  currency?: string;
  date?: string;
  reason?: string;
  status: 'success' | 'not_found';
  source: 'html' | 'sms' | 'puppeteer' | 'none';
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
    Accept: 'text/html,application/xhtml+xml',
  },
  validateStatus: () => true,
  maxRedirects: 5,
});

const DEBUG_DIR = './debug-receipts';
function saveDebug(tag: string, content: string) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const safe = tag.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
    fs.writeFileSync(path.join(DEBUG_DIR, `${safe}.html`), content);
  } catch { /* best-effort */ }
}

export type CbeInput =
  | { kind: 'url'; url: string }
  | { kind: 'sms'; text: string }
  | { kind: 'reference'; reference: string; suffix?: string }
  | { kind: 'mobileId'; mobileId: string };

export function classifyInput(raw: string, suffix?: string): CbeInput {
  const t = raw.trim();
  if (/^https?:\/\//i.test(t)) return { kind: 'url', url: t };
  if (/Dear\s+.+You have successfully transferred/i.test(t) || /Thanks for Banking with CBE/i.test(t)) {
    return { kind: 'sms', text: t };
  }
  if (/^FT[A-Z0-9]{6,}$/i.test(t)) return { kind: 'reference', reference: t, suffix };
  if (/^[A-Za-z0-9_-]{10,40}$/.test(t)) return { kind: 'mobileId', mobileId: t };
  return { kind: 'reference', reference: t, suffix };
}

export async function fetchCbeReceipt(
  referenceNumber: string,
  accountSuffix?: string,
): Promise<CbeReceipt> {
  const classified = classifyInput(referenceNumber, accountSuffix);
  switch (classified.kind) {
    case 'sms': return fetchFromSms(classified.text);
    case 'url': return fetchFromUrl(classified.url, referenceNumber);
    case 'mobileId': return fetchFromUrl(`${env.cbeMobileReceiptBase}v2-${classified.mobileId}`, classified.mobileId);
    case 'reference': return fetchFromReference(classified.reference, classified.suffix);
  }
}

async function fetchFromSms(text: string): Promise<CbeReceipt> {
  const smsResult = parseCbeSms(text);
  const urlMatch =
    text.match(/https:\/\/mbreciept\.cbe\.com\.et\/v2-[A-Za-z0-9_-]+/i) ||
    text.match(/https:\/\/apps\.cbe\.com\.et[^\s]+/i);
  if (urlMatch) {
    try {
      const htmlResult = await fetchFromUrl(urlMatch[0], smsResult.referenceNumber);
      if (htmlResult.status === 'success') {
        const merged: any = { ...smsResult };
        for (const [k, v] of Object.entries(htmlResult)) {
          if (v !== undefined && v !== null) merged[k] = v;
        }
        return merged as CbeReceipt;
      }
    } catch { /* fall through */ }
  }
  return smsResult;
}

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

  const dr = flat.match(/Disaster Recovery\(?\d*%?\)?\s*of\s*([\d,]+\.?\d*)/i);
  if (dr) result.disasterRecovery = parseAmount(dr[1]);

  const total = flat.match(/with total of ETB\s*([\d,]+\.?\d*)/i);
  if (total) result.totalAmount = parseAmount(total[1]);

  const bal = flat.match(/current balance is ETB\s*([\d,]+\.?\d*)/i);
  if (bal) result.currentBalance = parseAmount(bal[1]);

  const meaningful = [result.amount, result.receiverAccount, result.receiverName].filter(Boolean).length;
  if (meaningful < 2) return { referenceNumber: result.referenceNumber, status: 'not_found', source: 'sms' };
  return result;
}

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
    });
  }
  return browserPromise;
}

async function fetchFromUrl(url: string, fallbackRef: string): Promise<CbeReceipt> {
  try {
    const res = await http.get(url);
    const html = typeof res.data === 'string' ? res.data : String(res.data ?? '');
    saveDebug(`axios_${fallbackRef}`, html);
    const looksLikeSpa = /Loading receipt|id="root"|id="app"/i.test(html) && html.length < 8000;
    if (!looksLikeSpa && html.length > 500) {
      const parsed = parseCbeReceiptHtml(fallbackRef, html, url);
      if (parsed.status === 'success') return parsed;
    }
  } catch (e: any) {
    saveDebug(`axios_err_${fallbackRef}`, String(e?.message ?? e));
  }

  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36');

    let capturedJson: any = null;
    const capturedApis: string[] = [];
    page.on('response', async (response) => {
      capturedApis.push(response.url());
      const ct = response.headers()['content-type'] ?? '';
      if (ct.includes('application/json')) {
        try {
          const json = await response.json();
          if (json && typeof json === 'object') {
            capturedJson = json;
            saveDebug(`puppeteer_json_${fallbackRef}`, JSON.stringify(json, null, 2));
          }
        } catch { /* ignore */ }
      }
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2500));

    const renderedHtml = await page.content();
    saveDebug(`puppeteer_${fallbackRef}`, renderedHtml);
    const bodyText = await page.evaluate(() => document.body.innerText);
    saveDebug(`puppeteer_text_${fallbackRef}`, bodyText);
    saveDebug(`puppeteer_apis_${fallbackRef}`, capturedApis.join('\n'));
    await page.close();

    if (capturedJson) {
      const fromJson = parseCbeJson(capturedJson, fallbackRef);
      if (fromJson.status === 'success') return fromJson;
    }
    const parsed = parseCbeReceiptHtml(fallbackRef, renderedHtml, url);
    if (parsed.status === 'success') return { ...parsed, source: 'puppeteer' };
    const smsStyle = parseCbeSms(bodyText);
    if (smsStyle.status === 'success') return { ...smsStyle, source: 'puppeteer' };
    return { referenceNumber: fallbackRef, status: 'not_found', source: 'puppeteer' };
  } catch (e: any) {
    saveDebug(`puppeteer_err_${fallbackRef}`, String(e?.stack ?? e));
    return { referenceNumber: fallbackRef, status: 'not_found', source: 'none' };
  }
}

async function fetchFromReference(reference: string, suffix?: string): Promise<CbeReceipt> {
  const candidates: string[] = [];
  if (suffix) {
    candidates.push(`${env.cbeReceiptBase}?id=${encodeURIComponent(reference + suffix)}`);
    candidates.push(`${env.cbeReceiptBase}?id=${encodeURIComponent(reference)}&suffix=${encodeURIComponent(suffix)}`);
  }
  candidates.push(`${env.cbeReceiptBase}?id=${encodeURIComponent(reference)}`);
  let last: CbeReceipt = { referenceNumber: reference, status: 'not_found', source: 'none' };
  for (const url of candidates) {
    const r = await fetchFromUrl(url, reference);
    if (r.status === 'success') return r;
    last = r;
  }
  return last;
}

function parseCbeJson(json: any, fallbackRef: string): CbeReceipt {
  const flat: Record<string, any> = {};
  const walk = (obj: any, prefix = '') => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key);
      else flat[key.toLowerCase()] = v;
    }
  };
  walk(json);
  const get = (...keys: string[]): any => {
    for (const k of keys) {
      const v = flat[k.toLowerCase()];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };

  const receipt: CbeReceipt = {
    referenceNumber: String(get('transactionId', 'referenceNumber', 'reference', 'transaction.id', 'id') ?? fallbackRef),
    mobileReceiptId: String(get('mobileReceiptId', 'receiptId') ?? '') || undefined,
    payerName: asString(get('payerName', 'senderName', 'sender.name', 'payer.name', 'fromName')),
    payerAccount: asString(get('payerAccount', 'senderAccount', 'fromAccount', 'debitAccount')),
    receiverName: asString(get('receiverName', 'beneficiaryName', 'creditedPartyName', 'receiver.name', 'toName')),
    receiverAccount: asString(get('receiverAccount', 'beneficiaryAccount', 'creditAccount', 'toAccount')),
    amount: asNumber(get('amount', 'transactionAmount', 'transferredAmount')),
    serviceCharge: asNumber(get('serviceCharge', 'charge', 'commission')),
    vat: asNumber(get('vat', 'tax')),
    disasterRecovery: asNumber(get('disasterRecovery', 'disasterRecoveryFee')),
    totalAmount: asNumber(get('totalAmount', 'total', 'totalPaid')),
    currentBalance: asNumber(get('currentBalance', 'balance')),
    currency: asString(get('currency')) ?? 'ETB',
    date: asString(get('date', 'transactionDate', 'timestamp', 'createdAt', 'paymentDate')),
    reason: asString(get('reason', 'narrative', 'description', 'remark')),
    status: 'success',
    source: 'puppeteer',
  };
  const meaningful = [receipt.payerName, receipt.receiverName, receipt.amount, receipt.referenceNumber].filter(Boolean).length;
  if (meaningful < 2) return { referenceNumber: fallbackRef, status: 'not_found', source: 'puppeteer' };
  return receipt;
}

export function parseCbeReceiptHtml(referenceNumber: string, html: string, sourceUrl?: string): CbeReceipt {
  const $ = cheerio.load(html);
  const bodyLower = $('body').text().toLowerCase();
  if (/receipt\s*not\s*found|transaction\s*not\s*found|invalid\s*reference|no\s*record/i.test(bodyLower)) {
    return { referenceNumber, status: 'not_found', source: 'html' };
  }
  const rawText = $('body').text().replace(/\s+/g, ' ').trim();

  const narrativePattern = /ETB\s+([\d,]+\.?\d*)\s+has been debited from\s+(.+?)\s+ETB-?\s*(\d+)\s+for\s+(.+?)\s+ETB-?\s*(\d+)\s+on\s+(.+?)\s+with transaction ID:?\s*([A-Z0-9]+)/i;
  const narrative = rawText.match(narrativePattern);
  if (narrative) {
    const reasonMatch = rawText.match(/Reason:\s*(.+?)(?:\.|Total Amount|$)/i);
    return {
      referenceNumber: narrative[7],
      payerName: narrative[2].trim(),
      payerAccount: narrative[3],
      receiverName: narrative[4].trim(),
      receiverAccount: narrative[5],
      amount: parseAmount(narrative[1]),
      currency: 'ETB',
      date: narrative[6].trim(),
      reason: reasonMatch?.[1]?.trim(),
      status: 'success',
      source: 'html',
    };
  }

  const smsStyle = parseCbeSms(rawText);
  if (smsStyle.status === 'success') return { ...smsStyle, source: 'html' };

  const fields: Record<string, string> = {};
  $('table tr').each((_, row) => {
    const cells = $(row).find('td, th');
    if (cells.length < 2) return;
    const label = normalize($(cells[0]).text());
    const value = clean($(cells[1]).text());
    if (label && value) fields[label] = value;
  });

  if (Object.keys(fields).length === 0) {
    $('div, p, li, span').each((_, el) => {
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

  const amountStr = pick('Transaction Amount', 'Amount', 'Total Amount', 'Credit Amount', 'Debit Amount', 'Transferred Amount');
  const mobileId = sourceUrl?.match(/\/v2-([A-Za-z0-9_-]+)/i)?.[1];

  const receipt: CbeReceipt = {
    referenceNumber: pick('Reference Number', 'Transaction Reference', 'Reference', 'Transaction ID', 'Txn ID') ?? mobileId ?? referenceNumber,
    mobileReceiptId: mobileId,
    payerName: pick('Payer Name', 'Sender Name', 'Payer', 'From', 'Debit Account Name'),
    payerAccount: pick('Payer Account', 'Payer Account Number', 'Sender Account', 'Debit Account'),
    receiverName: pick('Receiver Name', 'Beneficiary Name', 'Receiver', 'To', 'Credit Account Name'),
    receiverAccount: pick('Receiver Account', 'Beneficiary Account', 'Receiver Account Number', 'Credit Account'),
    amount: amountStr ? parseAmount(amountStr) : undefined,
    currency: pick('Currency') ?? (/ETB|Birr/i.test(bodyLower) ? 'ETB' : undefined),
    date: pick('Transaction Date', 'Date', 'Payment Date', 'Date & Time', 'Transaction Time'),
    reason: pick('Reason', 'Payment Reason', 'Narrative', 'Description', 'Remark'),
    status: 'success',
    source: 'html',
  };

  const meaningful = [receipt.payerName, receipt.receiverName, receipt.amount, receipt.referenceNumber].filter(Boolean).length;
  if (meaningful < 2) return { referenceNumber, status: 'not_found', source: 'html' };
  return receipt;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[:ï¼š]\s*$/, '').trim();
}
function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
function parseAmount(s: string): number | undefined {
  const cleaned = s.replace(/[^\d.,-]/g, '').replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}
function asString(v: any): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s || undefined;
}
function asNumber(v: any): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') return v;
  return parseAmount(String(v));
}