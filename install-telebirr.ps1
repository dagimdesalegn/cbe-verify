$ErrorActionPreference = "Stop"
$root = "C:\Users\Dagi\Desktop\cbe-verify-api"
Set-Location $root

New-Item -ItemType Directory -Force -Path "src\services" | Out-Null

function W($rel, $content) {
    $full = Join-Path $root $rel
    $dir = Split-Path $full -Parent
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
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

Write-Host "`n=== Writing verificationService.ts ===" -ForegroundColor Yellow
W "src\services\verificationService.ts" @'
import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { fetchCbeReceipt } from './cbeScraper';
import { fetchTelebirrReceipt } from './telebirrScraper';
import { deliverWebhook } from './webhookService';
import { sseBus } from './sseBus';
import { logger } from '../utils/logger';

export interface VerifyInput {
  bank: string;
  referenceNumber?: string;
  reference?: string;
  accountSuffix?: string;
  suffix?: string;
  webhookUrl?: string;
}

export interface VerifyResult {
  requestId: string;
  bank: string;
  processingStatus: 'completed' | 'failed';
  status: 'success' | 'failed' | 'not_found';
  verified: boolean;
  amount?: number;
  currency?: string;
  senderName?: string;
  senderAccount?: string;
  receiverName?: string;
  receiverAccount?: string;
  referenceNumber?: string;
  accountSuffix?: string;
  date?: string;
  reason?: string;
  serviceCharge?: number;
  vat?: number;
  totalAmount?: number;
  source?: string;
  error?: string;
}

const insertStmt = db.prepare(`
  INSERT INTO verification_requests
    (request_id, bank, reference_number, account_suffix, webhook_url, idempotency_key, processing_status)
  VALUES (@request_id, @bank, @reference_number, @account_suffix, @webhook_url, @idempotency_key, 'queued')
`);

const updateStmt = db.prepare(`
  UPDATE verification_requests SET
    processing_status = @processing_status,
    status = @status,
    verified = @verified,
    amount = @amount,
    currency = @currency,
    sender_name = @sender_name,
    receiver_name = @receiver_name,
    receiver_account = @receiver_account,
    raw_data = @raw_data,
    error = @error,
    completed_at = datetime('now')
  WHERE request_id = @request_id
`);

const findByIdem = db.prepare(`SELECT * FROM verification_requests WHERE idempotency_key = ?`);
const findById = db.prepare(`SELECT * FROM verification_requests WHERE request_id = ?`);

export function getRequestById(id: string) {
  return findById.get(id) as any;
}

export function createRequest(input: VerifyInput, idempotencyKey?: string): string {
  if (idempotencyKey) {
    const existing = findByIdem.get(idempotencyKey) as any;
    if (existing) return existing.request_id;
  }
  const requestId = randomUUID();
  insertStmt.run({
    request_id: requestId,
    bank: input.bank,
    reference_number: input.referenceNumber ?? input.reference ?? null,
    account_suffix: input.accountSuffix ?? input.suffix ?? null,
    webhook_url: input.webhookUrl ?? null,
    idempotency_key: idempotencyKey ?? null,
  });
  return requestId;
}

export async function runVerification(requestId: string, input: VerifyInput): Promise<VerifyResult> {
  updateStmt.run({
    request_id: requestId,
    processing_status: 'running',
    status: 'pending',
    verified: 0,
    amount: null, currency: null,
    sender_name: null, receiver_name: null, receiver_account: null,
    raw_data: null, error: null,
  });
  sseBus.emit(requestId, { requestId, processingStatus: 'running', status: 'pending', verified: false });

  const reference = input.referenceNumber ?? input.reference ?? '';
  const bank = input.bank.toLowerCase();
  let result: VerifyResult;

  try {
    if (bank === 'cbe') {
      const receipt = await fetchCbeReceipt(reference, input.accountSuffix ?? input.suffix);

      if (receipt.status === 'not_found') {
        result = {
          requestId, bank: input.bank, processingStatus: 'completed',
          status: 'not_found', verified: false,
          referenceNumber: receipt.referenceNumber || reference,
          error: receipt.error,
        };
      } else {
        result = {
          requestId, bank: input.bank, processingStatus: 'completed',
          status: 'success', verified: true,
          amount: receipt.amount,
          currency: receipt.currency,
          senderName: receipt.payerName,
          senderAccount: receipt.payerAccount,
          receiverName: receipt.receiverName,
          receiverAccount: receipt.receiverAccount,
          referenceNumber: receipt.referenceNumber,
          accountSuffix: input.accountSuffix ?? input.suffix,
          date: receipt.date,
          reason: receipt.reason,
          serviceCharge: receipt.serviceCharge,
          vat: receipt.vat,
          totalAmount: receipt.totalAmount,
          source: receipt.source,
        };
      }
    } else if (bank === 'telebirr') {
      const receipt = await fetchTelebirrReceipt(reference);

      if (receipt.status === 'not_found') {
        result = {
          requestId, bank: input.bank, processingStatus: 'completed',
          status: 'not_found', verified: false,
          referenceNumber: receipt.referenceNumber || reference,
          error: receipt.error,
        };
      } else {
        result = {
          requestId, bank: input.bank, processingStatus: 'completed',
          status: 'success', verified: true,
          amount: receipt.amount,
          currency: receipt.currency,
          senderName: receipt.payerName,
          senderAccount: receipt.payerPhone,
          receiverName: receipt.receiverName,
          receiverAccount: receipt.receiverAccount || receipt.receiverPhone,
          referenceNumber: receipt.referenceNumber,
          date: receipt.date,
          serviceCharge: receipt.serviceFee,
          vat: receipt.vat,
          totalAmount: receipt.totalPaid,
          source: receipt.source,
        };
      }
    } else {
      throw new Error('Unsupported bank: ' + input.bank + '. Supported banks: cbe, telebirr.');
    }

    updateStmt.run({
      request_id: requestId,
      processing_status: result.processingStatus,
      status: result.status,
      verified: result.verified ? 1 : 0,
      amount: result.amount ?? null,
      currency: result.currency ?? null,
      sender_name: result.senderName ?? null,
      receiver_name: result.receiverName ?? null,
      receiver_account: result.receiverAccount ?? null,
      raw_data: JSON.stringify(result),
      error: result.error ?? null,
    });
  } catch (err: any) {
    logger.error({ err, requestId }, 'verification failed');
    result = {
      requestId, bank: input.bank, processingStatus: 'failed',
      status: 'failed', verified: false,
      error: err?.message ?? 'Verification failed',
    };
    updateStmt.run({
      request_id: requestId,
      processing_status: 'failed', status: 'failed', verified: 0,
      amount: null, currency: null,
      sender_name: null, receiver_name: null, receiver_account: null,
      raw_data: null, error: result.error ?? 'unknown',
    });
  }

  sseBus.emit(requestId, {
    requestId, processingStatus: result.processingStatus,
    status: result.status, verified: result.verified,
  });
  sseBus.close(requestId, 'terminal');

  const row = findById.get(requestId) as any;
  if (row?.webhook_url) {
    deliverWebhook(row.webhook_url, {
      event: 'verification.completed',
      requestId,
      timestamp: new Date().toISOString(),
      data: result,
    }).catch((e) => logger.warn({ e, requestId }, 'webhook delivery failed'));
  }
  return result;
}
'@

Write-Host "`n=== Writing app.js (with Telebirr tab) ===" -ForegroundColor Yellow
W "public\app.js" @'
const $ = (id) => document.getElementById(id);
const HISTORY_KEY = 'cbe_verify_history';
const KEY_STORAGE = 'cbe_verify_api_key';

function getApiKey() { return $('apiKey').value.trim(); }
function saveApiKey() { localStorage.setItem(KEY_STORAGE, getApiKey()); }
function loadApiKey() { const k = localStorage.getItem(KEY_STORAGE); if (k) $('apiKey').value = k; }

async function checkKey() {
  const key = getApiKey();
  if (!key) { $('keyStatus').textContent = 'Enter your API key'; $('keyStatus').className = 'text-xs mt-2 text-gray-500'; return false; }
  try {
    const res = await fetch('/api/api-keys', { headers: { 'x-api-key': key } });
    if (res.ok || res.status === 403) {
      $('keyStatus').textContent = 'Key valid';
      $('keyStatus').className = 'text-xs mt-2 text-green-400';
      return true;
    }
    $('keyStatus').textContent = 'Invalid key';
    $('keyStatus').className = 'text-xs mt-2 text-red-400';
    return false;
  } catch {
    $('keyStatus').textContent = 'Server unreachable';
    $('keyStatus').className = 'text-xs mt-2 text-yellow-400';
    return false;
  }
}

$('apiKey').addEventListener('input', () => { saveApiKey(); checkKey(); });
$('toggleKey').addEventListener('click', () => {
  const inp = $('apiKey');
  if (inp.type === 'password') { inp.type = 'text'; $('toggleKey').textContent = 'Hide'; }
  else { inp.type = 'password'; $('toggleKey').textContent = 'Show'; }
});

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => { b.classList.remove('tab-active'); b.classList.add('tab-inactive'); });
    btn.classList.remove('tab-inactive'); btn.classList.add('tab-active');
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
    $('tab-' + btn.dataset.tab).classList.remove('hidden');
  });
});

async function verify(bank, payload) {
  const key = getApiKey();
  if (!key) { showError('Enter your API key first'); return; }
  showLoading();
  try {
    const res = await fetch('/api/verify?waitMs=30000', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify(Object.assign({ bank: bank }, payload)),
    });
    const data = await res.json();
    showResult(data);
    if (data.success && data.data && data.data[0]) addToHistory(data.data[0]);
  } catch (e) { showError(e.message || 'Request failed'); }
}

$('verifySms').addEventListener('click', () => {
  const sms = $('smsText').value.trim();
  if (!sms) return showError('Paste the SMS text first');
  verify('cbe', { referenceNumber: sms });
});
$('verifyRef').addEventListener('click', () => {
  const ref = $('refNumber').value.trim();
  const suffix = $('refSuffix').value.trim();
  if (!ref) return showError('Enter a reference number');
  verify('cbe', { referenceNumber: ref, accountSuffix: suffix || undefined });
});
$('verifyUrl').addEventListener('click', () => {
  const url = $('receiptUrl').value.trim();
  if (!url) return showError('Paste a receipt URL');
  verify('cbe', { referenceNumber: url });
});

$('verifyTelebirrSms').addEventListener('click', () => {
  const sms = $('telebirrSmsText').value.trim();
  if (!sms) return showError('Paste the Telebirr SMS text first');
  verify('telebirr', { referenceNumber: sms });
});
$('verifyTelebirrRef').addEventListener('click', () => {
  const ref = $('telebirrRef').value.trim();
  if (!ref) return showError('Enter a Telebirr transaction number');
  verify('telebirr', { referenceNumber: ref });
});

function showLoading() {
  $('result').innerHTML = '<div class="card rounded-2xl p-8 flex flex-col items-center gap-3 fade-in"><div class="relative"><div class="w-12 h-12 rounded-full border-2 border-purple-500/30 absolute inset-0 pulse-ring"></div><svg class="w-12 h-12 text-purple-500 spinner" fill="none" viewBox="0 0 24 24"><circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle><path class="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z"></path></svg></div><div class="text-sm text-gray-400">Verifying payment...</div><div class="text-xs text-gray-500">This may take up to 30 seconds</div></div>';
}
function showError(msg) {
  $('result').innerHTML = '<div class="card rounded-2xl p-6 fade-in border-red-900/50"><div class="flex items-start gap-3"><div class="w-10 h-10 rounded-full bg-red-900/30 flex items-center justify-center flex-shrink-0"><svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg></div><div><div class="font-medium text-red-300">Error</div><div class="text-sm text-gray-400 mt-1">' + escapeHtml(msg) + '</div></div></div></div>';
}
function showResult(res) {
  const item = res.data && res.data[0];
  if (!item) return showError(res.message || 'No data returned');
  if (item.status === 'success' && item.verified) {
    let fields = '';
    fields += field('Amount', fmtAmount(item.amount, item.currency));
    fields += field('Reference', item.referenceNumber);
    fields += field('Sender', item.senderName);
    fields += field('Sender account', item.senderAccount);
    fields += field('Receiver', item.receiverName);
    fields += field('Receiver account', item.receiverAccount);
    fields += field('Date', item.date);
    fields += field('Reason', item.reason);
    fields += field('Service charge', fmtAmount(item.serviceCharge, item.currency));
    fields += field('VAT', fmtAmount(item.vat, item.currency));
    fields += field('Total debited', fmtAmount(item.totalAmount, item.currency));
    fields += field('Bank', item.bank);
    $('result').innerHTML = '<div class="card rounded-2xl p-6 fade-in border-green-900/50"><div class="flex items-start gap-4"><div class="w-12 h-12 rounded-full bg-green-600/20 border border-green-600/40 flex items-center justify-center flex-shrink-0"><svg class="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg></div><div class="flex-1"><div class="font-semibold text-green-300 text-lg">Payment Verified</div><div class="text-sm text-gray-400 mt-1">This transaction is valid and confirmed.</div><div class="grid grid-cols-2 gap-4 mt-5 text-sm">' + fields + '</div></div></div></div>';
  } else if (item.status === 'not_found') {
    $('result').innerHTML = '<div class="card rounded-2xl p-6 fade-in border-yellow-900/50"><div class="flex items-start gap-4"><div class="w-12 h-12 rounded-full bg-yellow-600/20 border border-yellow-600/40 flex items-center justify-center flex-shrink-0"><svg class="w-6 h-6 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01"/></svg></div><div><div class="font-semibold text-yellow-300 text-lg">Not Found</div><div class="text-sm text-gray-400 mt-1">Receipt not found for this input.</div></div></div></div>';
  } else { showError(item.error || res.message || 'Verification failed'); }
}
function field(label, value) {
  return '<div><div class="text-xs text-gray-500 uppercase tracking-wide">' + escapeHtml(label) + '</div><div class="text-gray-100 mt-0.5 font-mono break-all">' + escapeHtml(value == null || value === '' ? '-' : value) + '</div></div>';
}
function fmtAmount(amount, currency) {
  if (amount == null) return '-';
  return Number(amount).toLocaleString() + ' ' + (currency || 'ETB');
}

function loadHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } }
function saveHistory(h) { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 10))); }
function addToHistory(item) {
  const h = loadHistory();
  h.unshift({ ts: Date.now(), amount: item.amount, currency: item.currency, sender: item.senderName, receiver: item.receiverName, ref: item.referenceNumber, status: item.status, bank: item.bank });
  saveHistory(h); renderHistory();
}
function renderHistory() {
  const h = loadHistory();
  if (!h.length) { $('history').innerHTML = '<div class="text-xs text-gray-600 italic">No verifications yet</div>'; return; }
  $('history').innerHTML = h.map(function (r) {
    return '<div class="card rounded-xl px-4 py-3 flex items-center justify-between text-sm"><div class="flex items-center gap-3"><div class="w-2 h-2 rounded-full ' + (r.status === 'success' ? 'bg-green-500' : 'bg-yellow-500') + '"></div><div><div class="text-gray-200">' + escapeHtml(r.sender || '-') + ' to ' + escapeHtml(r.receiver || '-') + '</div><div class="text-xs text-gray-500 font-mono">' + escapeHtml(r.bank || '') + ' · ' + escapeHtml(r.ref || '') + '</div></div></div><div class="text-right"><div class="text-gray-100">' + (r.amount ? Number(r.amount).toLocaleString() + ' ' + (r.currency || 'ETB') : '') + '</div><div class="text-xs text-gray-500">' + new Date(r.ts).toLocaleTimeString() + '</div></div></div>';
  }).join('');
}
$('clearHistory').addEventListener('click', () => { localStorage.removeItem(HISTORY_KEY); renderHistory(); });

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); });
}

loadApiKey();
renderHistory();
if (getApiKey()) checkKey();
'@

Write-Host "`n=== Writing index.html (with Telebirr tab) ===" -ForegroundColor Yellow
W "public\index.html" @'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Ethiopian Payment Verification</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
body { background:#0b0d12; color:#e5e7eb; font-family:system-ui,-apple-system,sans-serif; }
.card { background:linear-gradient(160deg,#131722 0%,#0d1018 100%); border:1px solid #1f2937; }
.input { background:#0a0d14; border:1px solid #1f2937; }
.input:focus { border-color:#7c3aed; outline:none; box-shadow:0 0 0 3px rgba(124,58,237,.15); }
.tab-active { background:#7c3aed; color:#fff; }
.tab-inactive { color:#94a3b8; }
.tab-inactive:hover { color:#e5e7eb; }
.spinner { animation:spin 1s linear infinite; }
@keyframes spin { from{transform:rotate(0)} to{transform:rotate(360deg)} }
.pulse-ring { animation:pulse-ring 1.5s ease-out infinite; }
@keyframes pulse-ring { 0%{transform:scale(.9);opacity:.7} 70%{transform:scale(1.4);opacity:0} 100%{transform:scale(.9);opacity:0} }
.fade-in { animation:fadeIn .3s ease-out; }
@keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
.bank-tab-active { background:#059669; color:#fff; }
.bank-tab-inactive { background:#1f2937; color:#94a3b8; }
</style>
</head>
<body class="min-h-screen">
<header class="border-b border-gray-800">
<div class="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
<div class="flex items-center gap-3">
<div class="w-9 h-9 rounded-lg bg-gradient-to-br from-purple-600 to-purple-800 flex items-center justify-center">
<svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>
</svg>
</div>
<div>
<div class="font-semibold text-white">Ethiopian Payment Verify</div>
<div class="text-xs text-gray-500">CBE + Telebirr</div>
</div>
</div>
<a href="/api/api-keys" target="_blank" class="text-sm text-gray-400 hover:text-white">API Keys</a>
</div>
</header>

<main class="max-w-3xl mx-auto px-6 py-10">
<div class="card rounded-2xl p-6 mb-6">
<div class="flex items-center justify-between mb-3">
<label class="text-sm font-medium text-gray-300">API Key</label>
<span class="text-xs text-gray-500">Stored only in your browser</span>
</div>
<div class="flex gap-2">
<input id="apiKey" type="password" placeholder="cbe_verify_..." class="input rounded-lg px-4 py-2.5 text-sm w-full font-mono" />
<button id="toggleKey" class="px-3 rounded-lg border border-gray-800 hover:bg-gray-800 text-sm">Show</button>
</div>
<div id="keyStatus" class="text-xs mt-2 text-gray-500">Not verified</div>
</div>

<div class="flex gap-2 mb-4">
<button data-tab="sms" class="tab-btn tab-active px-4 py-2 rounded-lg text-sm font-medium transition">CBE SMS</button>
<button data-tab="ref" class="tab-btn tab-inactive px-4 py-2 rounded-lg text-sm font-medium transition">CBE Ref + Suffix</button>
<button data-tab="url" class="tab-btn tab-inactive px-4 py-2 rounded-lg text-sm font-medium transition">CBE URL</button>
<button data-tab="telebirrSms" class="tab-btn tab-inactive px-4 py-2 rounded-lg text-sm font-medium transition">Telebirr SMS</button>
<button data-tab="telebirrRef" class="tab-btn tab-inactive px-4 py-2 rounded-lg text-sm font-medium transition">Telebirr Ref</button>
</div>

<div id="tab-sms" class="tab-panel">
<div class="card rounded-2xl p-6">
<label class="text-sm font-medium text-gray-300 block mb-2">Paste the CBE confirmation SMS</label>
<textarea id="smsText" rows="6" placeholder="Dear [Name] You have successfully transferred ETB..." class="input rounded-lg px-4 py-3 text-sm w-full resize-none font-mono"></textarea>
<button id="verifySms" class="mt-4 w-full bg-purple-600 hover:bg-purple-500 text-white font-medium py-3 rounded-lg transition">Verify CBE Payment</button>
</div>
</div>

<div id="tab-ref" class="tab-panel hidden">
<div class="card rounded-2xl p-6 space-y-4">
<div>
<label class="text-sm font-medium text-gray-300 block mb-2">Transaction reference</label>
<input id="refNumber" type="text" placeholder="FT26262VQ6GV" class="input rounded-lg px-4 py-2.5 text-sm w-full font-mono" />
</div>
<div>
<label class="text-sm font-medium text-gray-300 block mb-2">Account suffix (8 digits)</label>
<input id="refSuffix" type="text" placeholder="35207333" class="input rounded-lg px-4 py-2.5 text-sm w-full font-mono" />
</div>
<button id="verifyRef" class="w-full bg-purple-600 hover:bg-purple-500 text-white font-medium py-3 rounded-lg transition">Verify CBE Payment</button>
</div>
</div>

<div id="tab-url" class="tab-panel hidden">
<div class="card rounded-2xl p-6 space-y-4">
<div>
<label class="text-sm font-medium text-gray-300 block mb-2">CBE receipt URL</label>
<input id="receiptUrl" type="text" placeholder="https://mbreciept.cbe.com.et/v2-..." class="input rounded-lg px-4 py-2.5 text-sm w-full font-mono" />
</div>
<button id="verifyUrl" class="w-full bg-purple-600 hover:bg-purple-500 text-white font-medium py-3 rounded-lg transition">Verify CBE Payment</button>
</div>
</div>

<div id="tab-telebirrSms" class="tab-panel hidden">
<div class="card rounded-2xl p-6">
<label class="text-sm font-medium text-gray-300 block mb-2">Paste the Telebirr SMS from 127</label>
<textarea id="telebirrSmsText" rows="6" placeholder="Dear [Name] You have transferred ETB ... Thank you for using telebirr" class="input rounded-lg px-4 py-3 text-sm w-full resize-none font-mono"></textarea>
<button id="verifyTelebirrSms" class="mt-4 w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-3 rounded-lg transition">Verify Telebirr Payment</button>
</div>
</div>

<div id="tab-telebirrRef" class="tab-panel hidden">
<div class="card rounded-2xl p-6 space-y-4">
<div>
<label class="text-sm font-medium text-gray-300 block mb-2">Telebirr transaction number</label>
<input id="telebirrRef" type="text" placeholder="DIN92X87AT" class="input rounded-lg px-4 py-2.5 text-sm w-full font-mono" />
</div>
<button id="verifyTelebirrRef" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-3 rounded-lg transition">Verify Telebirr Payment</button>
</div>
</div>

<div id="result" class="mt-6"></div>

<div class="mt-10">
<div class="flex items-center justify-between mb-3">
<h2 class="text-sm font-medium text-gray-400">Recent verifications</h2>
<button id="clearHistory" class="text-xs text-gray-500 hover:text-gray-300">Clear</button>
</div>
<div id="history" class="space-y-2"></div>
</div>
</main>

<script src="/app.js"></script>
</body>
</html>
'@

Write-Host "`n=== Writing test-api.js (with Telebirr tests) ===" -ForegroundColor Yellow
W "test-api.js" @'
const BASE = 'http://localhost:3000';
const ADMIN = process.env.ADMIN_API_KEY || 'cbe_admin_local_dev_key_change_me';

async function jfetch(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

(async () => {
  console.log('\n=== 1. Health check ===');
  {
    const r = await jfetch(BASE + '/health/live');
    console.log('Status:', r.status, '| Body:', JSON.stringify(r.body));
  }

  console.log('\n=== 2. Create API key ===');
  let key;
  {
    const r = await jfetch(BASE + '/api/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ADMIN },
      body: JSON.stringify({ name: 'test-key-' + Date.now() }),
    });
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
    key = r.body && r.body.data && r.body.data.key;
    if (!key) { console.error('No key - aborting'); process.exit(1); }
    console.log('\n>>> API KEY: ' + key);
  }

  console.log('\n=== 3. CBE - Verify by SMS ===');
  {
    const sms = 'Dear Dagim Desalegn You have successfully transferred ETB1.00 from account 1********7333 to account 1********3794 (Abdulmejid Sehab Mohammed). Service charge of ETB 0.50 and VAT(15%) of ETB0.08 and Disaster Recovery(5%) of 0.03 with total of ETB1.61 .Your current balance is ETB3,338.74. Thanks for Banking with CBE. https://mbreciept.cbe.com.et/v2-hfHCxHaJXg7XVz9GQAvs';
    const r = await jfetch(BASE + '/api/verify?waitMs=15000', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'idempotency-key': 'cbe-sms-' + Date.now() },
      body: JSON.stringify({ bank: 'cbe', referenceNumber: sms }),
    });
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
  }

  console.log('\n=== 4. CBE - Verify by reference + suffix ===');
  {
    const r = await jfetch(BASE + '/api/verify?waitMs=30000', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'idempotency-key': 'cbe-ref-' + Date.now() },
      body: JSON.stringify({ bank: 'cbe', referenceNumber: 'FT26262VQ6GV', accountSuffix: '35207333' }),
    });
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
  }

  console.log('\n=== 5. Telebirr - Verify by SMS ===');
  {
    const sms = 'Dear Dagim You have transferred ETB 1.00 to bertukan desalegn (2519****6052) on 23/09/2026 20:07:03. Your transaction number is DIN92X87AT. The service fee is ETB 0.87 and 15% VAT on the service fee is ETB 0.13. Your current E-Money Account balance is ETB 14.63. To download your payment information please click this link: https://transactioninfo.ethiotelecom.et/receipt/DIN92X87AT. Thank you for using telebirr';
    const r = await jfetch(BASE + '/api/verify?waitMs=30000', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'idempotency-key': 'tb-sms-' + Date.now() },
      body: JSON.stringify({ bank: 'telebirr', referenceNumber: sms }),
    });
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
  }

  console.log('\n=== 6. Telebirr - Verify by transaction number ===');
  {
    const r = await jfetch(BASE + '/api/verify?waitMs=30000', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'idempotency-key': 'tb-ref-' + Date.now() },
      body: JSON.stringify({ bank: 'telebirr', referenceNumber: 'DIN92X87AT' }),
    });
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
  }

  console.log('\n=== Done ===');
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
'@

Write-Host "`n=== All files written ===" -ForegroundColor Green

Write-Host "`n=== Git add + commit + push ===" -ForegroundColor Yellow
git add .
git commit -m "Add Telebirr support: SMS parser, HTML parser, frontend tabs, tests"
git push

Write-Host "`n=== ALL DONE ===" -ForegroundColor Green
Write-Host "`nNow restart the server (Ctrl+C then npm run dev) and run: node test-api.js" -ForegroundColor Cyan