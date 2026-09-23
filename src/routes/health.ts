import { Router } from 'express';
const router = Router();
router.get('/health/live', (_req, res) => res.json({ ok: true }));
router.get('/health/ready', (_req, res) => res.json({ ok: true }));
export default router;