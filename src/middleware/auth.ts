import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { findByHash, touchKey } from '../services/apiKeyService';

export function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function requireApiKey(permission: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.header('x-api-key');
    if (!key) {
      return res.status(401).json({ success: false, message: 'Missing x-api-key header' });
    }
    const row = findByHash(hashKey(key));
    if (!row) {
      return res.status(401).json({ success: false, message: 'Invalid API key' });
    }
    const perms: string[] = JSON.parse(row.permissions);
    if (!perms.includes(permission)) {
      return res
        .status(403)
        .json({ success: false, message: `Permission denied: ${permission} required` });
    }
    (req as any).apiKey = row;
    touchKey(row.id);
    next();
  };
}