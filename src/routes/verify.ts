import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { requireApiKey } from '../middleware/auth';
import { createRequest, runVerification, getRequestById } from '../services/verificationService';
import { sseBus } from '../services/sseBus';
import { db } from '../db';
import { logger } from '../utils/logger';

const router = Router();

const verifyLimiter = rateLimit({
  windowMs: 60_000, max: 60,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'API key rate limit exceeded' },
});

const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s);

const verifySchema = z.object({
  bank: z.string().min(2),
  referenceNumber: z.string().min(3).optional(),
  reference: z.string().min(3).optional(),
  accountSuffix: z.string().optional(),
  suffix: z.string().optional(),
  webhookUrl: z.string().optional().refine((v) => !v || isUrl(v), 'webhookUrl must be a valid http(s) URL'),
}).refine((v) => v.referenceNumber || v.reference, { message: 'referenceNumber or reference is required' });

router.post('/verify', requireApiKey('verification:write'), verifyLimiter, async (req, res, next) => {
  try {
    const body = verifySchema.parse(req.body);
    const idempotencyKey = req.header('Idempotency-Key') ?? undefined;
    const webhookHeader = req.header('X-Webhook-Url');
    if (webhookHeader && !body.webhookUrl) body.webhookUrl = webhookHeader;
    const requestId = createRequest(body as any, idempotencyKey);
    const rawWait = Number((req.query as any).waitMs ?? 0);
    const waitMs = Math.min(Number.isFinite(rawWait) ? rawWait : 0, 30_000);
    const runPromise = runVerification(requestId, body as any);
    if (waitMs > 0) {
      const result = await Promise.race([runPromise, new Promise<null>((r) => setTimeout(() => r(null), waitMs))]);
      if (result) return res.status(200).json(envelopeSuccess(requestId, result));
    } else {
      runPromise.catch((e) => logger.error({ e, requestId }, 'background verification failed'));
    }
    return res.status(202).json(envelopeQueued(requestId, body.bank));
  } catch (err) { next(err); }
});

router.get('/verify/history', requireApiKey('verification:read'), (_req, res) => {
  const rows = db.prepare(`SELECT * FROM verification_requests ORDER BY created_at DESC LIMIT 50`).all() as any[];
  res.json({
    success: true, message: 'Verification history.',
    data: rows.map((r) => ({
      requestId: r.request_id, bank: r.bank,
      processingStatus: r.processing_status, status: r.status,
      verified: !!r.verified, createdAt: r.created_at,
    })),
    meta: { total: rows.length, limit: 50, offset: 0 },
  });
});

router.get('/verify/:requestId/events', requireApiKey('verification:read'), (req, res) => {
  const { requestId } = req.params;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('\n');
  const onStatus = (data: object) => res.write(`event: status\ndata: ${JSON.stringify(data)}\n\n`);
  const onDone = (data: object) => { res.write(`event: done\ndata: ${JSON.stringify(data)}\n\n`); res.end(); };
  sseBus.on(`status:${requestId}`, onStatus);
  sseBus.on(`done:${requestId}`, onDone);
  req.on('close', () => {
    sseBus.off(`status:${requestId}`, onStatus);
    sseBus.off(`done:${requestId}`, onDone);
  });
});

router.get('/verify/:requestId', requireApiKey('verification:read'), (req, res) => {
  const row = getRequestById(req.params.requestId) as any;
  if (!row) return res.status(404).json({ success: false, message: 'Not found' });
  return res.json({
    success: true, message: 'Verification status.',
    data: {
      requestId: row.request_id, bank: row.bank,
      processingStatus: row.processing_status, status: row.status,
      verified: !!row.verified, completedAt: row.completed_at,
    },
  });
});

function envelopeSuccess(requestId: string, result: any) {
  return {
    success: true,
    message: result.status === 'success' ? 'Transaction verified successfully.' : 'Verification completed.',
    data: [{
      bank: result.bank,
      status: result.status,
      verified: result.verified,
      amount: result.amount,
      currency: result.currency,
      senderName: result.senderName,
      senderAccount: result.senderAccount,
      receiverName: result.receiverName,
      receiverAccount: result.receiverAccount,
      referenceNumber: result.referenceNumber,
      accountSuffix: result.accountSuffix,
      date: result.date,
      reason: result.reason,
      serviceCharge: result.serviceCharge,
      vat: result.vat,
      totalAmount: result.totalAmount,
      source: result.source,
    }],
    requestId,
    verification: { requestId, processingStatus: result.processingStatus, status: result.status, verified: result.verified },
    links: { statusUrl: `/api/verify/${requestId}` },
  };
}

function envelopeQueued(requestId: string, bank: string) {
  return {
    success: true, message: 'Verification queued.', data: [],
    requestId, statusUrl: `/api/verify/${requestId}`, estimatedWaitMs: 5000,
    verification: { requestId, bank, processingStatus: 'queued', status: 'pending', verified: false },
    links: { statusUrl: `/api/verify/${requestId}`, pollAfterMs: 1500, webhookRegistered: false },
  };
}

export default router;