import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { fetchCbeReceipt } from './cbeScraper';
import { fetchTelebirrReceipt } from './telebirrScraper';
import { fetchBoaReceipt } from './boaScraper';
import { fetchDashenReceipt } from './dashenScraper';
import { fetchMpesaReceipt } from './mpesaScraper';
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
  geoBlocked?: boolean;
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

export async function runVerification(
  requestId: string,
  input: VerifyInput,
): Promise<VerifyResult> {
  updateStmt.run({
    request_id: requestId,
    processing_status: 'running',
    status: 'pending',
    verified: 0,
    amount: null,
    currency: null,
    sender_name: null,
    receiver_name: null,
    receiver_account: null,
    raw_data: null,
    error: null,
  });
  sseBus.emit(requestId, {
    requestId,
    processingStatus: 'running',
    status: 'pending',
    verified: false,
  });

  const reference = input.referenceNumber ?? input.reference ?? '';
  const bank = input.bank.toLowerCase();
  const suffix = input.accountSuffix ?? input.suffix;
  let result: VerifyResult;

  try {
    if (bank === 'cbe') {
      const receipt = await fetchCbeReceipt(reference, suffix);

      if (receipt.status === 'not_found') {
        result = {
          requestId, bank: input.bank, processingStatus: 'completed',
          status: 'not_found', verified: false,
          referenceNumber: receipt.referenceNumber || reference,
          error: receipt.error,
        };
      } else if (receipt.status === 'failed') {
        result = {
          requestId, bank: input.bank, processingStatus: 'failed',
          status: 'failed', verified: false,
          referenceNumber: receipt.referenceNumber || reference,
          error: receipt.error || 'Fetch failed',
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
          accountSuffix: suffix,
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
      } else if (receipt.status === 'failed') {
        result = {
          requestId, bank: input.bank, processingStatus: 'failed',
          status: 'failed', verified: false,
          referenceNumber: receipt.referenceNumber || reference,
          geoBlocked: receipt.geoBlocked,
          error: receipt.error || 'Fetch failed',
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
    } else if (bank === 'boa') {
      const receipt = await fetchBoaReceipt(reference, suffix);

      if (receipt.status === 'not_found') {
        result = {
          requestId, bank: input.bank, processingStatus: 'completed',
          status: 'not_found', verified: false,
          referenceNumber: receipt.referenceNumber || reference,
          error: receipt.error,
        };
      } else if (receipt.status === 'failed') {
        result = {
          requestId, bank: input.bank, processingStatus: 'failed',
          status: 'failed', verified: false,
          referenceNumber: receipt.referenceNumber || reference,
          error: receipt.error || 'Fetch failed',
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
          accountSuffix: suffix,
          date: receipt.date,
          source: receipt.source,
        };
      }
    } else if (bank === 'dashen') {
      const receipt = await fetchDashenReceipt(reference);

      if (receipt.status === 'not_found') {
        result = {
          requestId, bank: input.bank, processingStatus: 'completed',
          status: 'not_found', verified: false,
          referenceNumber: receipt.referenceNumber || reference,
          error: receipt.error,
        };
      } else if (receipt.status === 'failed') {
        result = {
          requestId, bank: input.bank, processingStatus: 'failed',
          status: 'failed', verified: false,
          referenceNumber: receipt.referenceNumber || reference,
          error: receipt.error || 'Fetch failed',
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
          date: receipt.date,
          serviceCharge: receipt.serviceCharge,
          vat: receipt.vat,
          totalAmount: receipt.totalAmount,
          source: receipt.source,
        };
      }
    } else if (bank === 'mpesa') {
      const receipt = await fetchMpesaReceipt(reference);

      if (receipt.status === 'not_found') {
        result = {
          requestId, bank: input.bank, processingStatus: 'completed',
          status: 'not_found', verified: false,
          referenceNumber: receipt.referenceNumber || reference,
          error: receipt.error,
        };
      } else if (receipt.status === 'failed') {
        result = {
          requestId, bank: input.bank, processingStatus: 'failed',
          status: 'failed', verified: false,
          referenceNumber: receipt.referenceNumber || reference,
          geoBlocked: receipt.geoBlocked,
          error: receipt.error || 'Fetch failed',
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
          receiverAccount: receipt.receiverAccount,
          referenceNumber: receipt.referenceNumber,
          date: receipt.date,
          serviceCharge: receipt.serviceCharge,
          source: receipt.source,
        };
      }
    } else {
      throw new Error(
        'Unsupported bank: ' + input.bank + '. Supported banks: cbe, telebirr, boa, dashen, mpesa.',
      );
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
      processing_status: 'failed',
      status: 'failed',
      verified: 0,
      amount: null,
      currency: null,
      sender_name: null,
      receiver_name: null,
      receiver_account: null,
      raw_data: null,
      error: result.error ?? 'unknown',
    });
  }

  sseBus.emit(requestId, {
    requestId,
    processingStatus: result.processingStatus,
    status: result.status,
    verified: result.verified,
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