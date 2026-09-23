$ErrorActionPreference = "Stop"
$root = "C:\Users\Dagi\Desktop\cbe-verify-api"
Set-Location $root

function W($rel, $content) {
    $full = Join-Path $root $rel
    [System.IO.File]::WriteAllText($full, $content, [System.Text.UTF8Encoding]::new($false))
    Write-Host "  wrote: $rel" -ForegroundColor Cyan
}

Write-Host "`n=== Writing telebirrScraper.ts with Amharic/English label parser ===" -ForegroundColor Yellow
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
  currency?: string;
  date?: string;
  status: 'success' | 'not_found' | 'failed';
  source: 'sms' | 'html' | 'none';
  error?: string;
  geoBlocked?: boolean;
}

const TIMEOUT = Number(process.env.TELEBIRR_FETCH_TIMEOUT_MS ?? 10000);

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

// -------------------------------------------------------------
// SMS parser
// -------------------------------------------------------------

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

// -------------------------------------------------------------
// URL / reference
// -------------------------------------------------------------

async function fetchFromReference(reference: string): Promise<TelebirrReceipt> {
  const ref = reference.trim().toUpperCase();
  return fetchFromUrl('https://transactioninfo.ethiotelecom.et/receipt/' + encodeURIComponent(ref));
}

async function fetchFromUrl(url: string): Promise<TelebirrReceipt> {
  const ref = url.match(/\/receipt\/([A-Z0-9]+)/i)?.[1] ?? url;
  let res = await tryFetch(httpDesktop, url);
  if (!res.ok) res = await tryFetch(httpApp, url);

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

async function tryFetch(c: AxiosInstance, url: string): Promise<FetchOutcome> {
  try {
    const res = await c.get(url);
    return { ok: true, status: res.status, html: typeof res.data === 'string' ? res.data : String(res.data ?? '') };
  } catch (e: any) {
    const msg = String(e?.message ?? '');
    const geoBlocked = e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT' || e?.code === 'ENOTFOUND' || /timeout/i.test(msg);
    return { ok: false, status: 0, html: '', geoBlocked, error: msg };
  }
}

// -------------------------------------------------------------
// HTML parser — handles Amharic/English dual labels
// -------------------------------------------------------------
// Real Telebirr label format:
//   የከፋይ ስም/Payer Name Dagim Desalegn Chane
//   የክፍያ ቁጥር/Invoice No. DIN92X87AT
//   የተከፈለው መጠን/Settled Amount 1 Birr
// Values are separated from labels by whitespace and stop at the next Amharic char.

export function parseTelebirrHtml(referenceNumber: string, html: string): TelebirrReceipt {
  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();

  if (/not found|invalid|no record|does not exist/i.test(bodyText) && bodyText.length < 500) {
    return { referenceNumber, status: 'not_found', source: 'html' };
  }

  // Extract value after a specific English label. Stops at the next Amharic char (U+1200-U+137F)
  // or at "end of string".
  const get = (label: string): string | undefined => {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(esc + '[\\s.:\\u00A0]*([^]*?)(?=[\\u1200-\\u137F]|$)', 'i');
    const m = bodyText.match(re);
    if (!m) return undefined;
    const val = m[1].replace(/\s+/g, ' ').trim();
    return val.length > 0 ? val : undefined;
  };

  // Amounts may be followed by "Birr" - strip it
  const amountFrom = (label: string): number | undefined => {
    const v = get(label);
    if (!v) return undefined;
    const cleaned = v.replace(/Birr/i, '').trim();
    return parseAmount(cleaned);
  };

  const r: TelebirrReceipt = {
    referenceNumber,
    status: 'success',
    source: 'html',
    currency: 'ETB',
  };

  r.payerName = get('Payer Name');
  r.payerPhone = get('Payer telebirr no.');
  r.receiverName = get('Credited Party name');
  r.receiverAccount = get('Credited party account no');
  r.referenceNumber = get('Invoice No.') ?? referenceNumber;
  r.date = get('Payment date');
  r.amount = amountFrom('Settled Amount');
  r.serviceFee = amountFrom('Service fee VAT') !== undefined ? amountFrom('Service fee') : amountFrom('Service fee');
  r.vat = amountFrom('Service fee VAT');
  r.totalPaid = amountFrom('Total Paid Amount');

  // Fallback to table-based parsing if nothing found
  if (!r.payerName && !r.receiverName && !r.amount) {
    const fields: Record<string, string> = {};
    $('tr').each((_, row) => {
      const cells = $(row).find('td, th');
      if (cells.length < 2) return;
      const l = cells.eq(0).text().replace(/\s+/g, ' ').trim().toLowerCase();
      const v = cells.eq(1).text().replace(/\s+/g, ' ').trim();
      if (l && v) fields[l] = v;
    });

    const pick = (...keys: string[]) => {
      for (const k of keys) {
        const kk = k.toLowerCase();
        for (const [fk, fv] of Object.entries(fields)) {
          if (fk.endsWith(kk)) return fv;
        }
      }
      return undefined;
    };

    if (!r.payerName) r.payerName = pick('payer name');
    if (!r.receiverName) r.receiverName = pick('credited party name', 'receiver name');
    if (!r.referenceNumber) r.referenceNumber = pick('invoice no.', 'receipt number', 'transaction number') ?? referenceNumber;
    if (!r.date) r.date = pick('payment date', 'transaction date');
    if (!r.amount) r.amount = parseAmount((pick('settled amount', 'amount') ?? '').replace(/Birr/i, ''));
    if (!r.totalPaid) r.totalPaid = parseAmount((pick('total paid amount', 'total paid') ?? '').replace(/Birr/i, ''));
  }

  // Success criteria: need at least 2 meaningful fields
  const meaningful = [r.payerName, r.receiverName, r.amount, r.referenceNumber].filter(Boolean).length;
  if (meaningful < 2) return { referenceNumber, status: 'not_found', source: 'html' };
  return r;
}

function parseAmount(s: string): number | undefined {
  if (!s) return undefined;
  const c = s.replace(/[^\d.,-]/g, '').replace(/,/g, '');
  const n = Number(c);
  return Number.isFinite(n) ? n : undefined;
}
'@

Write-Host "`n=== Running test ===" -ForegroundColor Green
node test-telebirr-direct.js DIN92X87AT

Write-Host "`n=== Committing and pushing ===" -ForegroundColor Yellow
git add .
git commit -m "Fix Telebirr HTML parser: handle Amharic/English dual labels"
git push

Write-Host "`n=== DONE ===" -ForegroundColor Green