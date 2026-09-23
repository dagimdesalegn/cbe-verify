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
  geoBlocked?: boolean;
}

const TELEBIRR_TIMEOUT_MS = Number(process.env.TELEBIRR_FETCH_TIMEOUT_MS ?? 8000);
const TELEBIRR_PROXY_URL = process.env.TELEBIRR_PROXY_URL ?? '';
const TELEBIRR_PROXY_SECRET = process.env.TELEBIRR_PROXY_SECRET ?? '';

const httpsAgent = env.cbeAllowInsecureTls
  ? new https.Agent({ rejectUnauthorized: false })
  : undefined;

const http: AxiosInstance = axios.create({
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
  if (/You have transferred|Thank you for using telebirr/i.test(t)) return { kind: 'sms', text: t };
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
// SMS parser — works from anywhere, no network call
// -------------------------------------------------------------

export function parseTelebirrSms(text: string): TelebirrReceipt {
  const flat = text.replace(/\s+/g, ' ').trim();
  const result: TelebirrReceipt = {
    referenceNumber: '',
    status: 'success',
    source: 'sms',
    currency: 'ETB',
  };

  const senderMatch = flat.match(/^Dear\s+([A-Za-z][A-Za-z\s]+?)\s+You have transferred/i);
  if (senderMatch) result.payerName = senderMatch[1].trim();

  const txMatch = flat.match(/transaction number is\s+([A-Z0-9]+)/i);
  if (txMatch) result.referenceNumber = txMatch[1];

  const urlMatch = flat.match(/https:\/\/transactioninfo\.ethiotelecom\.et\/receipt\/([A-Z0-9]+)/i);
  if (urlMatch && !result.referenceNumber) result.referenceNumber = urlMatch[1];

  const amt = flat.match(/transferred\s+ETB\s*([\d,]+\.?\d*)/i);
  if (amt) result.amount = parseAmount(amt[1]);

  const toMatch = flat.match(/to\s+(.+?)\s+\((\d{4}\*+\d{4})\)/i);
  if (toMatch) {
    result.receiverName = toMatch[1].trim();
    result.receiverPhone = toMatch[2];
  }

  const fee = flat.match(/service fee is\s+ETB\s*([\d,]+\.?\d*)/i);
  if (fee) result.serviceFee = parseAmount(fee[1]);

  const vat = flat.match(/VAT on the service fee is ETB\s*([\d,]+\.?\d*)/i);
  if (vat) result.vat = parseAmount(vat[1]);

  if (result.amount !== undefined) {
    const total = result.amount + (result.serviceFee || 0);
    result.totalPaid = Number(total.toFixed(2));
  }

  const bal = flat.match(/balance is ETB\s*([\d,]+\.?\d*)/i);
  if (bal) result.currentBalance = parseAmount(bal[1]);

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
  if (smsResult.status !== 'success' || !smsResult.referenceNumber) return smsResult;

  const urlMatch = text.match(/https:\/\/transactioninfo\.ethiotelecom\.et\/receipt\/[A-Z0-9]+/i);
  if (!urlMatch) return smsResult;

  try {
    const htmlResult = await fetchFromUrl(urlMatch[0]);
    if (htmlResult.status === 'success' && (htmlResult.receiverName || htmlResult.amount)) {
      const merged: any = { ...smsResult };
      for (const [k, v] of Object.entries(htmlResult)) {
        if (v !== undefined && v !== null && v !== '' && v !== 'none') merged[k] = v;
      }
      merged.source = 'html';
      return merged;
    }
  } catch { /* ignore — SMS data is already complete */ }

  return smsResult;
}

// -------------------------------------------------------------
// Reference + URL
// -------------------------------------------------------------

async function fetchFromReference(reference: string): Promise<TelebirrReceipt> {
  const cleanRef = reference.trim().toUpperCase();
  const url = 'https://transactioninfo.ethiotelecom.et/receipt/' + encodeURIComponent(cleanRef);
  return fetchFromUrl(url);
}

async function fetchFromUrl(url: string): Promise<TelebirrReceipt> {
  const refMatch = url.match(/\/receipt\/([A-Z0-9]+)/i);
  const referenceNumber = refMatch ? refMatch[1] : url;

  // Route via relay if configured (for Ethiopian deployment)
  const fetchUrl = TELEBIRR_PROXY_URL
    ? TELEBIRR_PROXY_URL + '?url=' + encodeURIComponent(url)
    : url;

  const headers: Record<string, string> = {};
  if (TELEBIRR_PROXY_URL && TELEBIRR_PROXY_SECRET) {
    headers['x-relay-secret'] = TELEBIRR_PROXY_SECRET;
  }

  try {
    const res = await http.get(fetchUrl, { timeout: TELEBIRR_TIMEOUT_MS, headers });
    const html = typeof res.data === 'string' ? res.data : String(res.data ?? '');
    saveDebug('telebirr_' + referenceNumber + '.html', html);

    if (res.status >= 400) {
      return { referenceNumber, status: 'failed', source: 'none', error: 'HTTP ' + res.status };
    }

    if (!html || html.length < 100) {
      return { referenceNumber, status: 'failed', source: 'none', error: 'Empty response from Telebirr' };
    }

    const parsed = parseTelebirrHtml(referenceNumber, html);
    if (parsed.status === 'success') return parsed;

    return { referenceNumber, status: 'not_found', source: 'html', error: 'Page loaded but no receipt data found' };
  } catch (e: any) {
    saveDebug('telebirr_err_' + referenceNumber + '.txt', String(e?.stack ?? e));

    const msg = String(e?.message ?? '');
    const geoBlocked =
      e?.code === 'ECONNABORTED' ||
      e?.code === 'ETIMEDOUT' ||
      e?.code === 'ECONNREFUSED' ||
      e?.code === 'ENOTFOUND' ||
      /timeout/i.test(msg);

    return {
      referenceNumber,
      status: 'failed',
      source: 'none',
      geoBlocked,
      error: geoBlocked
        ? 'Telebirr receipt URLs only respond from Ethio Telecom / Ethiopian IPs. ' +
          'Use the SMS-based verification - it works everywhere. ' +
          'To enable URL lookup, deploy telebirr-relay.js on an Ethiopian server and set TELEBIRR_PROXY_URL.'
        : (e?.message ?? 'Fetch failed'),
    };
  }
}

// -------------------------------------------------------------
// HTML parser
// -------------------------------------------------------------

export function parseTelebirrHtml(referenceNumber: string, html: string): TelebirrReceipt {
  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

  if (/not found|invalid|no record|does not exist/i.test(bodyText) && bodyText.length < 500) {
    return { referenceNumber, status: 'not_found', source: 'html' };
  }

  const result: TelebirrReceipt = {
    referenceNumber,
    status: 'success',
    source: 'html',
    currency: 'ETB',
  };

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
      const m = t.match(/^([A-Za-z][A-Za-z0-9 /_-]{2,40}?)\s*[:：]\s*(.+)$/);
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

  const get = (re: RegExp): string | undefined => {
    const m = bodyText.match(re);
    return m && m[1] ? m[1].trim() : undefined;
  };

  const amountStr = pick('Amount', 'Total Paid Amount', 'Total Amount', 'Transaction Amount', 'Settled Amount', 'Paid Amount');
  result.payerName = pick('Payer Name', 'Sender Name', 'Payer', 'From') ||
    get(/Payer\s*Name[:\s]+([A-Za-z][A-Za-z\s]+?)(?=\s+(?:Payer|Receiver|Credited|Payment|Amount|Invoice|$))/i);
  result.payerPhone = pick('Payer Telebirr No', 'Payer Phone', 'Sender Phone') ||
    get(/Payer\s*Telebirr\s*No[:\s]+(\d{4}\*+\d{4})/i);
  result.receiverName = pick('Credited Party Name', 'Receiver Name', 'Beneficiary Name', 'To') ||
    get(/Credited\s*Party\s*Name[:\s]+([A-Za-z][A-Za-z\s]+?)(?=\s+(?:Payer|Receiver|Credited|Payment|Amount|Invoice|$))/i);
  result.receiverAccount = pick('Credited Party Account No', 'Receiver Account', 'Beneficiary Account') ||
    get(/Credited\s*Party\s*Account\s*No[:\s]+(\d{4}\*+\d{4})/i);
  result.amount = amountStr ? parseAmount(amountStr) : undefined;
  result.serviceFee = parseAmount(pick('Service Fee', 'Service Charge', 'Fee') ?? '') ?? undefined;
  result.vat = parseAmount(pick('VAT', 'Tax') ?? '') ?? undefined;
  result.totalPaid = parseAmount(pick('Total Paid Amount', 'Total Paid') ?? '') ?? undefined;
  result.currentBalance = parseAmount(pick('Current Balance', 'Balance') ?? '') ?? undefined;
  result.date = pick('Payment Date', 'Transaction Date', 'Date') ||
    get(/Payment\s*Date[:\s]+(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/i);
  result.referenceNumber = pick('Invoice Number', 'Receipt Number', 'Transaction Number') || referenceNumber;

  const meaningful = [result.amount, result.receiverName, result.referenceNumber].filter(Boolean).length;
  if (meaningful < 2) return { referenceNumber, status: 'not_found', source: 'html' };
  return result;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[:：]\s*$/, '').trim();
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
'@

Write-Host "`n=== Writing telebirr-relay.js ===" -ForegroundColor Yellow
W "telebirr-relay.js" @'
// telebirr-relay.js
// Deploy this on an Ethiopian server (Ethio Telecom network).
// It proxies Telebirr receipt fetches from your main API so that
// geo-restricted receipt URLs respond correctly.
//
// Run:  node telebirr-relay.js
// Env:  PORT=4000  RELAY_SECRET=change_me
// Then set on your main API:
//   TELEBIRR_PROXY_URL=http://your-ethiopian-server:4000/relay
//   TELEBIRR_PROXY_SECRET=change_me

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 4000);
const SECRET = process.env.RELAY_SECRET || '';
const ALLOWED_HOST = 'transactioninfo.ethiotelecom.et';

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, 'http://localhost:' + PORT);

  if (reqUrl.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (reqUrl.pathname !== '/relay') {
    res.writeHead(404);
    return res.end('Use /relay?url=<encoded>');
  }

  if (SECRET && req.headers['x-relay-secret'] !== SECRET) {
    res.writeHead(401);
    return res.end('Unauthorized');
  }

  const targetUrl = reqUrl.searchParams.get('url');
  if (!targetUrl) {
    res.writeHead(400);
    return res.end('Missing ?url=');
  }

  let parsed;
  try { parsed = new URL(targetUrl); } catch {
    res.writeHead(400);
    return res.end('Invalid URL');
  }

  if (parsed.hostname !== ALLOWED_HOST) {
    res.writeHead(403);
    return res.end('Only ' + ALLOWED_HOST + ' is allowed');
  }

  https
    .get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0 TelebirrRelay/1.0' } }, (upstream) => {
      res.writeHead(upstream.statusCode || 502, {
        'content-type': upstream.headers['content-type'] || 'text/html',
      });
      upstream.pipe(res);
    })
    .on('error', (e) => {
      res.writeHead(502);
      res.end('Upstream error: ' + e.message);
    });
});

server.listen(PORT, () => {
  console.log('Telebirr relay listening on port ' + PORT);
  console.log('Deploy on an Ethiopian/Ethio Telecom server.');
  console.log('Set TELEBIRR_PROXY_URL on your main API to enable URL-based Telebirr verification.');
});
'@

Write-Host "`n=== Appending Telebirr vars to .env and .env.example ===" -ForegroundColor Yellow

$telebirrVars = "`nTELEBIRR_PROXY_URL=`nTELEBIRR_PROXY_SECRET=`nTELEBIRR_FETCH_TIMEOUT_MS=8000"

foreach ($f in @(".env", ".env.example")) {
    $path = Join-Path $root $f
    if (Test-Path $path) {
        $content = [System.IO.File]::ReadAllText($path)
        if ($content -notmatch 'TELEBIRR_PROXY_URL') {
            [System.IO.File]::AppendAllText($path, $telebirrVars)
            Write-Host "  appended Telebirr vars to $f" -ForegroundColor Cyan
        } else {
            Write-Host "  $f already has Telebirr vars" -ForegroundColor DarkGray
        }
    }
}

Write-Host "`n=== Git add + commit + push ===" -ForegroundColor Yellow
git add .
git commit -m "Add Telebirr geo-block handling: fast-fail, clear message, optional Ethiopian relay"
git push

Write-Host "`n=== DONE ===" -ForegroundColor Green
Write-Host "`nRestart server (Ctrl+C then npm run dev) and run: node test-api.js" -ForegroundColor Cyan