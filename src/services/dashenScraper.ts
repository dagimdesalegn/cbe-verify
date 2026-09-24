import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse: any = require('pdf-parse');

export interface DashenReceipt {
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
  source: 'pdf' | 'html' | 'none';
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
    Accept: 'text/html,application/pdf,application/xhtml+xml,*/*',
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

export async function fetchDashenReceipt(reference: string): Promise<DashenReceipt> {
  const cleanRef = reference.trim().toUpperCase();
  const url = `https://receipts.dashenbanksc.com/receipt/${encodeURIComponent(cleanRef)}`;

  try {
    const res = await http.get(url, { responseType: 'arraybuffer' });

    if (res.status >= 400) {
      return {
        referenceNumber: cleanRef,
        status: 'not_found',
        source: 'none',
        error: `HTTP ${res.status}`,
      };
    }

    const buffer = Buffer.from(res.data);
    const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
    saveDebug(`dashen_${cleanRef}.bin`, buffer);

    if (buffer.length < 100) {
      return { referenceNumber: cleanRef, status: 'not_found', source: 'none', error: 'Empty response' };
    }

    if (contentType.includes('pdf') || buffer.slice(0, 5).toString() === '%PDF-') {
      return parseDashenPdf(buffer, cleanRef);
    }

    const html = buffer.toString('utf-8');
    if (html.length > 200) {
      saveDebug(`dashen_${cleanRef}.html`, html);
      return parseDashenHtml(cleanRef, html);
    }

    return { referenceNumber: cleanRef, status: 'not_found', source: 'none', error: 'Unrecognized response format' };
  } catch (e: any) {
    saveDebug(`dashen_err_${cleanRef}.txt`, String(e?.stack ?? e));
    return { referenceNumber: cleanRef, status: 'failed', source: 'none', error: e?.message ?? 'Fetch failed' };
  }
}

// -------------------------------------------------------------
// PDF parser
// -------------------------------------------------------------

async function parseDashenPdf(buffer: Buffer, referenceNumber: string): Promise<DashenReceipt> {
  try {
    const data = await pdfParse(buffer);
    const text = String(data.text ?? '').replace(/\s+/g, ' ').trim();
    saveDebug(`dashen_pdf_text_${referenceNumber}.txt`, text);

    if (!text || text.length < 30) {
      return { referenceNumber, status: 'not_found', source: 'pdf', error: 'PDF has no readable text' };
    }

    const get = (label: string): string | undefined => {
      const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(esc + '[\\s:]*([^]*?)(?=\\s{2,}|$)', 'i');
      const m = text.match(re);
      return m && m[1] ? m[1].trim() : undefined;
    };

    const receipt: DashenReceipt = {
      referenceNumber: get('FT Ref') ?? get('Transaction Reference') ?? referenceNumber,
      payerName: cleanName(get('Sender Name')),
      payerAccount: cleanAccount(get('Sender Account')),
      receiverName: cleanName(get('Receiver Name')),
      receiverAccount: cleanAccount(get('Recipient Account') ?? get('Receiver Account')),
      amount: parseAmount(get('Amount')),
      currency: 'ETB',
      date: get('Date'),
      status: 'success',
      source: 'pdf',
    };

    const meaningful = [receipt.payerName, receipt.receiverName, receipt.amount, receipt.referenceNumber].filter(Boolean).length;
    if (meaningful < 2) {
      return { referenceNumber, status: 'not_found', source: 'pdf', error: 'PDF parsed but no fields recognized' };
    }
    return receipt;
  } catch (e: any) {
    saveDebug(`dashen_pdf_err_${referenceNumber}.txt`, String(e?.stack ?? e));
    return { referenceNumber, status: 'failed', source: 'pdf', error: `PDF parse error: ${e?.message}` };
  }
}

// -------------------------------------------------------------
// HTML parser
// -------------------------------------------------------------
// Dashen HTML structure:
//   <p><strong>Sender Name:</strong> Dagim Desalegn Chane</p>
//   <p><strong>Sender Account Number:</strong> 5169******011</p>
//   <p><strong>Receiver Name:</strong> Abdulmejid Sehab Mohammed</p>
//   <p><strong>Receiver Account Number: </strong> 2955******111</p>
//   <p><strong>Transaction Reference:</strong> 169WDTS2626700WH</p>
//   <p><strong>Transaction Date:</strong> Sep 24, 2026, 08:44:18 am</p>
//   <td>Transaction Amount</td><td>ETB 5.00</td>
//   <td>Total</td><td>ETB 5.00</td>

function parseDashenHtml(referenceNumber: string, html: string): DashenReceipt {
  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

  if (/not found|invalid|no record|does not exist/i.test(bodyText) && bodyText.length < 500) {
    return { referenceNumber, status: 'not_found', source: 'html' };
  }

  // Strategy 1: <p><strong>Label:</strong> Value</p>
  const fields: Record<string, string> = {};

  $('p, div, li').each((_, el) => {
    const $el = $(el);
    const strong = $el.find('strong, b').first();
    if (strong.length === 0) return;
    const label = strong.text().replace(/:\s*$/, '').trim();
    // Value = full text minus the label
    const fullText = $el.text().trim();
    const value = fullText.replace(strong.text(), '').replace(/^[:\s]+/, '').trim();
    if (label && value) fields[label.toLowerCase().replace(/\s+/g, ' ')] = value;
  });

  // Strategy 2: table cells (fallback)
  $('tr').each((_, row) => {
    const cells = $(row).find('td, th');
    if (cells.length < 2) return;
    const label = cells.eq(0).text().trim();
    const value = cells.eq(1).text().trim();
    if (label && value && !fields[label.toLowerCase().replace(/\s+/g, ' ')]) {
      fields[label.toLowerCase().replace(/\s+/g, ' ')] = value;
    }
  });

  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const kk = k.toLowerCase();
      if (fields[kk]) return fields[kk];
      for (const [fk, fv] of Object.entries(fields)) {
        if (fk.includes(kk)) return fv;
      }
    }
    return undefined;
  };

  const receipt: DashenReceipt = {
    referenceNumber:
      pick('transaction reference', 'ft ref', 'reference') ?? referenceNumber,
    payerName: cleanName(pick('sender name')),
    payerAccount: cleanAccount(pick('sender account number', 'sender account')),
    receiverName: cleanName(pick('receiver name')),
    receiverAccount: cleanAccount(pick('receiver account number', 'receiver account', 'recipient account')),
    amount: parseAmount(pick('transaction amount', 'amount')),
    serviceCharge: parseAmount(pick('service charge')),
    vat: parseAmount(pick('vat (15%)', 'vat')),
    totalAmount: parseAmount(pick('total')),
    currency: 'ETB',
    date: pick('transaction date', 'date'),
    status: 'success',
    source: 'html',
  };

  const meaningful = [
    receipt.payerName,
    receipt.receiverName,
    receipt.amount,
    receipt.referenceNumber,
  ].filter(Boolean).length;

  if (meaningful < 2) {
    return { referenceNumber, status: 'not_found', source: 'html' };
  }
  return receipt;
}

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------

function cleanName(s?: string): string | undefined {
  if (!s) return undefined;
  const c = s.replace(/^(Mr|Mrs|Ms|Dr|Prof)\.?\s+/i, '').replace(/\s+/g, ' ').trim();
  return c.length >= 2 ? c : undefined;
}
function cleanAccount(s?: string): string | undefined {
  if (!s) return undefined;
  const c = s.replace(/\s+/g, '').trim();
  if (!/^[\d*]+$/.test(c)) return undefined;
  if (c.length < 4) return undefined;
  return c;
}
function parseAmount(s?: string): number | undefined {
  if (!s) return undefined;
  const cleaned = s.replace(/[^\d.,-]/g, '').replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}