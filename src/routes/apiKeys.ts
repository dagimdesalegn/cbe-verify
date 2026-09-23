import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth';
import { generateApiKey, listKeys, revokeKey } from '../services/apiKeyService';

const router = Router();

const createSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  permissions: z.array(z.string()).optional(),
});

router.post('/api-keys', requireApiKey('apikeys:write'), (req, res) => {
  const body = createSchema.parse(req.body ?? {});
  const created = generateApiKey(body.name, body.permissions);
  res.status(201).json({
    success: true,
    message: 'API key created. Save this key â€” it will not be shown again.',
    data: { id: created.id, key: created.key },
  });
});

router.get('/api-keys', requireApiKey('apikeys:read'), (_req, res) => {
  res.json({ success: true, message: 'API keys.', data: listKeys() });
});

router.delete('/api-keys/:id', requireApiKey('apikeys:write'), (req, res) => {
  const ok = revokeKey(req.params.id);
  if (!ok) return res.status(404).json({ success: false, message: 'Not found' });
  res.json({ success: true, message: 'API key revoked.' });
});

export default router;