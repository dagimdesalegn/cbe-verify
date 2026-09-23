import crypto from 'node:crypto';
import { db } from '../db';

export interface ApiKeyRow {
  id: string;
  key_hash: string;
  key_prefix: string;
  name: string | null;
  permissions: string;
  enabled: number;
  is_admin: number;
  last_used_at: string | null;
  request_count: number;
  created_at: string;
}

const PREFIX = 'cbe_verify_';

export function generateApiKey(name?: string, permissions?: string[], isAdmin = false) {
  const randomPart = crypto.randomBytes(24).toString('base64url');
  const key = `${PREFIX}${randomPart}`;
  const id = crypto.randomUUID();
  const keyHash = crypto.createHash('sha256').update(key).digest('hex');
  const perms = permissions ?? ['verification:read', 'verification:write'];
  db.prepare(
    `INSERT INTO api_keys (id, key_hash, key_prefix, name, permissions, is_admin)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, keyHash, PREFIX, name ?? null, JSON.stringify(perms), isAdmin ? 1 : 0);
  return { id, key };
}

export function seedAdminKey(adminKey: string) {
  const h = crypto.createHash('sha256').update(adminKey).digest('hex');
  const exists = db.prepare(`SELECT id FROM api_keys WHERE key_hash = ?`).get(h);
  if (!exists) {
    db.prepare(
      `INSERT INTO api_keys (id, key_hash, key_prefix, name, permissions, is_admin)
       VALUES (?, ?, ?, ?, ?, 1)`,
    ).run(
      crypto.randomUUID(),
      h,
      adminKey.slice(0, 12),
      'Bootstrap Admin',
      JSON.stringify([
        'verification:read',
        'verification:write',
        'apikeys:read',
        'apikeys:write',
      ]),
    );
  }
}

export function findByHash(hash: string): ApiKeyRow | undefined {
  return db
    .prepare(`SELECT * FROM api_keys WHERE key_hash = ? AND enabled = 1`)
    .get(hash) as ApiKeyRow | undefined;
}

export function listKeys() {
  return db
    .prepare(
      `SELECT id, key_prefix, name, permissions, enabled, is_admin, last_used_at, request_count, created_at
       FROM api_keys ORDER BY created_at DESC`,
    )
    .all() as Omit<ApiKeyRow, 'key_hash'>[];
}

export function revokeKey(id: string): boolean {
  const info = db.prepare(`UPDATE api_keys SET enabled = 0 WHERE id = ?`).run(id);
  return info.changes > 0;
}

export function touchKey(id: string) {
  db.prepare(
    `UPDATE api_keys SET last_used_at = datetime('now'), request_count = request_count + 1 WHERE id = ?`,
  ).run(id);
}