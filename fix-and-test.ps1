$ErrorActionPreference = "Stop"
$root = "C:\Users\Dagi\Desktop\cbe-verify-api"
Set-Location $root

function W($rel, $content) {
    $full = Join-Path $root $rel
    [System.IO.File]::WriteAllText($full, $content, [System.Text.UTF8Encoding]::new($false))
    Write-Host "  wrote: $rel" -ForegroundColor Cyan
}

Write-Host "`n=== Writing telebirrScraper.ts ===" -ForegroundColor Yellow
W "src\services\telebirrScraper.ts" @'
import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import https from 'node:https';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';

try { dns.setDefaultResultOrder('ipv6first'); } catch {}

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
  geoBlocked?: boolean;
}

const TIMEOUT = Number(process.env.TELEBIRR_FETCH_TIMEOUT_MS ?? 10000);
const PROXY_URL = process.env.TELEBIRR_PROXY_URL ?? '';
const PROXY_SECRET = process.env.TELEBIRR_PROXY_SECRET ?? '';

const httpsAgent = env.cbeAllowInsecureTls
  ? new https.Agent({ rejectUnauthorized: false })
  : undefined;

const HEADERS_DESKTOP: Record<string, string> = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip, deflate, br',
  'cache-control': 'no-cache',
  'pragma': 'no-cache',
  'upgrade-insecure-requests': '1',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-fetch-site': 'none',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-user': '?1',
  'sec-fetch-dest': 'document',
};

const HEADERS_APP: Record<string, string> = {
  'user-agent': 'Telebirr/1.0 (Android)',
  'accept': 'text/html,application/xhtml+xml,*/*',
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip, deflate, br',
};

function client(headers: Record<string, string>): AxiosInstance {
  return axios.create({ httpsAgent, headers, validateStatus: () => true, maxRedirects: 5, timeout: TIMEOUT });
}

const httpDesktop = client(HEADERS_DESKTOP);
const httpApp = client(HEADERS_APP);

const DEBUG_DIR = './debug-receipts';
function saveDebug(tag: string, content: string) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEBUG_DIR, tag.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120)), content);
  } catch {}
}

export type TelebirrInput = { kind: 'sms'; text: string } | { kind: 'reference'; reference: string } | { kind: 'url'; url: string };

export function classifyTelebirrInput(raw: string): TelebirrInput {
  const t = raw.trim();
  if (/^https?:\/\//i.test(t)) return { kind: 'url', url: t };
  if (/You have transferred|Thank you for using telebirr/i.test(t)) return { kind: 'sms', text: t };
  return { kind: 'reference', reference: t };
}

export async function fetchTelebirrReceipt(input: string): Promise<TelebirrReceipt> {
  const c = classifyTelebirrInput(input);
  if (c.kind === 'sms') return fetchFromSms(c.text);
  if (c.kind === 'reference') return fetchFromReference(c.reference);
  return fetchFromUrl(c.url);
}

export function parseTelebirrSms(text: string): TelebirrReceipt {
  const flat = text.replace(/\s+/g, ' ').trim();
  const r: TelebirrReceipt = { referenceNumber: '', status: 'success', source: 'sms', currency: 'ETB' };

  const s = flat.match(/^Dear\s+([A-Za-z][A-Za-z\s]+?)\s+You have transferred/i);
  if (s) r.payerName = s[1].trim();

  const tx = flat.match(/transaction number is\s+([A-Z0-9]+)/i);
  if (tx) r.referenceNumber = tx[1];

  const u = flat.match(/https:\/\/transactioninfo\.ethiotelecom\.et\/receipt\/([A-Z0-9]+)/i);
  if (u && !r.referenceNumber) r.referenceNumber = u[1];

  const a = flat.match(/transferred\s+ETB\s*([\d,]+\.?\d*)/i);
  if (a) r.amount = parseAmount(a[1]);

  const t = flat.match(/to\s+(.+?)\s+\((\d{4}\*+\d{4})\)/i);
  if (t) { r.receiverName = t[1].trim(); r.receiverPhone = t[2]; }

  const f = flat.match(/service fee is\s+ETB\s*([\d,]+\.?\d*)/i);
  if (f) r.serviceFee = parseAmount(f[1]);

  const v = flat.match(/VAT on the service fee is ETB\s*([\d,]+\.?\d*)/i);
  if (v) r.vat = parseAmount(v[1]);

  if (r.amount !== undefined) r.totalPaid = Number((r.amount + (r.serviceFee || 0)).toFixed(2));

  const b = flat.match(/balance is ETB\s*([\d,]+\.?\d*)/i);
  if (b) r.currentBalance = parseAmount(b[1]);

  const d = flat.match(/on\s+(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/i);
  if (d) r.date = d[1];

  const meaningful = [r.referenceNumber, r.amount, r.receiverName].filter(Boolean).length;
  if (meaningful < 2) return { referenceNumber: r.referenceNumber, status: 'not_found', source: 'sms' };
  return r;
}

async function fetchFromSms(text: string): Promise<TelebirrReceipt> {
  const sms = parseTelebirrSms(text);
  if (sms.status !== 'success' || !sms.referenceNumber) return sms;
  const u = text.match(/https:\/\/transactioninfo\.ethiotelecom\.et\/receipt\/[A-Z0-9]+/i);
  if (!u) return sms;
  try {
    const html = await fetchFromUrl(u[0]);
    if (html.status === 'success' && (html.receiverName || html.amount)) {
      const m: any = { ...sms };
      for (const [k, v] of Object.entries(html)) if (v !== undefined && v !== null && v !== '' && v !== 'none') m[k] = v;
      m.source = 'html';
      return m;
    }
  } catch {}
  return sms;
}

async function fetchFromReference(reference: string): Promise<TelebirrReceipt> {
  const ref = reference.trim().toUpperCase();
  return fetchFromUrl('https://transactioninfo.ethiotelecom.et/receipt/' + encodeURIComponent(ref));
}

async function fetchFromUrl(url: string): Promise<TelebirrReceipt> {
  const ref = url.match(/\/receipt\/([A-Z0-9]+)/i)?.[1] ?? url;
  const target = PROXY_URL ? PROXY_URL + '?url=' + encodeURIComponent(url) : url;
  const extra: Record<string, string> = {};
  if (PROXY_URL && PROXY_SECRET) extra['x-relay-secret'] = PROXY_SECRET;

  let res = await tryFetch(httpDesktop, target, extra);
  if (!res.ok) res = await tryFetch(httpApp, target, extra);

  if (!res.ok) {
    return { referenceNumber: ref, status: 'failed', source: 'none', geoBlocked: res.geoBlocked, error: res.error || 'Fetch failed' };
  }
  saveDebug('telebirr_' + ref + '.html', res.html);
  if (res.status >= 400) return { referenceNumber: ref, status: 'failed', source: 'none', error: 'HTTP ' + res.status };
  if (!res.html || res.html.length < 100) return { referenceNumber: ref, status: 'failed', source: 'none', error: 'Empty response' };

  const parsed = parseTelebirrHtml(ref, res.html);
  if (parsed.status === 'success') return parsed;
  return { referenceNumber: ref, status: 'not_found', source: 'html', error: 'Page loaded (' + res.html.length + ' bytes) but no fields recognized' };
}

interface FetchOutcome { ok: boolean; status: number; html: string; error?: string; geoBlocked?: boolean; }

async function tryFetch(c: AxiosInstance, url: string, extra: Record<string, string>): Promise<FetchOutcome> {
  try {
    const res = await c.get(url, { headers: extra });
    return { ok: true, status: res.status, html: typeof res.data === 'string' ? res.data : String(res.data ?? '') };
  } catch (e: any) {
    const msg = String(e?.message ?? '');
    const geoBlocked = e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT' || e?.code === 'ENOTFOUND' || /timeout/i.test(msg);
    return { ok: false, status: 0, html: '', geoBlocked, error: msg };
  }
}

export function parseTelebirrHtml(referenceNumber: string, html: string): TelebirrReceipt {
  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  if (/not found|invalid|no record|does not exist/i.test(bodyText) && bodyText.length < 500) {
    return { referenceNumber, status: 'not_found', source: 'html' };
  }

  const fields: Record<string, string> = {};
  $('tr').each((_, row) => {
    const cells = $(row).find('td, th');
    if (cells.length < 2) return;
    const l = norm($(cells[0]).text());
    const v = clean($(cells[1]).text());
    if (l && v) fields[l] = v;
  });
  if (Object.keys(fields).length === 0) {
    $('div, p, li, span, section').each((_, el) => {
      const t = clean($(el).text());
      const m = t.match(/^([A-Za-z][A-Za-z0-9 /_-]{2,40}?)\s*[:：]\s*(.+)$/);
      if (m) { const k = norm(m[1]); if (!fields[k]) fields[k] = clean(m[2]); }
    });
  }

  const pick = (...keys: string[]) => { for (const k of keys) { const v = fields[norm(k)]; if (v) return v; } return undefined; };
  const get = (re: RegExp) => { const m = bodyText.match(re); return m && m[1] ? m[1].trim() : undefined; };

  const r: TelebirrReceipt = { referenceNumber, status: 'success', source: 'html', currency: 'ETB' };
  const amountStr = pick('Amount', 'Total Paid Amount', 'Total Amount', 'Transaction Amount', 'Settled Amount', 'Paid Amount');

  r.payerName = pick('Payer Name', 'Sender Name', 'Payer', 'From') || get(/Payer\s*Name[:\s]+([A-Za-z][A-Za-z\s]+?)(?=\s+(?:Payer|Receiver|Credited|Payment|Amount|Invoice|$))/i);
  r.payerPhone = pick('Payer Telebirr No', 'Payer Phone', 'Sender Phone') || get(/Payer\s*Telebirr\s*No[:\s]+(\d{4}\*+\d{4})/i);
  r.receiverName = pick('Credited Party Name', 'Receiver Name', 'Beneficiary Name', 'To') || get(/Credited\s*Party\s*Name[:\s]+([A-Za-z][A-Za-z\s]+?)(?=\s+(?:Payer|Receiver|Credited|Payment|Amount|Invoice|$))/i);
  r.receiverAccount = pick('Credited Party Account No', 'Receiver Account', 'Beneficiary Account') || get(/Credited\s*Party\s*Account\s*No[:\s]+(\d{4}\*+\d{4})/i);
  r.amount = amountStr ? parseAmount(amountStr) : undefined;
  r.serviceFee = parseAmount(pick('Service Fee', 'Service Charge', 'Fee') ?? '');
  r.vat = parseAmount(pick('VAT', 'Tax') ?? '');
  r.totalPaid = parseAmount(pick('Total Paid Amount', 'Total Paid') ?? '');
  r.currentBalance = parseAmount(pick('Current Balance', 'Balance') ?? '');
  r.date = pick('Payment Date', 'Transaction Date', 'Date') || get(/Payment\s*Date[:\s]+(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/i);
  r.referenceNumber = pick('Invoice Number', 'Receipt Number', 'Transaction Number') || referenceNumber;

  const meaningful = [r.amount, r.receiverName, r.referenceNumber].filter(Boolean).length;
  if (meaningful < 2) return { referenceNumber, status: 'not_found', source: 'html' };
  return r;
}

function norm(s: string): string { return s.toLowerCase().replace(/\s+/g, ' ').replace(/[:：]\s*$/, '').trim(); }
function clean(s: string): string { return s.replace(/\s+/g, ' ').trim(); }
function parseAmount(s: string): number | undefined {
  if (!s) return undefined;
  const c = s.replace(/[^\d.,-]/g, '').replace(/,/g, '');
  const n = Number(c);
  return Number.isFinite(n) ? n : undefined;
}
'@

Write-Host "`n=== Writing test-telebirr-direct.js ===" -ForegroundColor Yellow
W "test-telebirr-direct.js" @'
require('tsx/cjs');
const { fetchTelebirrReceipt } = require('./src/services/telebirrScraper.ts');
const fs = require('fs');

(async () => {
  const ref = process.argv[2] || 'DIN92X87AT';
  console.log('Testing Telebirr receipt:', ref);
  const start = Date.now();
  const result = await fetchTelebirrReceipt(ref);
  console.log('\n=== RESULT (' + (Date.now() - start) + 'ms) ===');
  console.log(JSON.stringify(result, null, 2));

  const f = './debug-receipts/telebirr_' + ref + '.html';
  if (fs.existsSync(f)) {
    const html = fs.readFileSync(f, 'utf8');
    console.log('\n=== HTML saved: ' + html.length + ' bytes ===');
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log('First 1500 chars of visible text:');
    console.log(text.slice(0, 1500));
  }
  process.exit(0);
})().catch(e => { console.error('FATAL:', e?.stack ?? e); process.exit(1); });
'@

Write-Host "`n=== Files written. Now testing Telebirr URL ===" -ForegroundColor Green
Write-Host "`n" -NoNewline
node test-telebirr-direct.js DIN92X87AT

Write-Host "`n=== Committing and pushing ===" -ForegroundColor Yellow
git add .
git commit -m "Fix Telebirr URL fetch: desktop UA + Client Hints, app UA fallback, IPv6-first"
git push

Write-Host "`n=== DONE ===" -ForegroundColor Green