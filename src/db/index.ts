import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';

fs.mkdirSync(path.dirname(env.dbPath), { recursive: true });

export const db = new Database(env.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS verification_requests (
  request_id         TEXT PRIMARY KEY,
  bank               TEXT NOT NULL,
  reference_number   TEXT,
  account_suffix     TEXT,
  phone_number       TEXT,
  settlement_account TEXT,
  processing_status  TEXT NOT NULL DEFAULT 'queued',
  status             TEXT,
  verified           INTEGER,
  amount             REAL,
  currency           TEXT,
  sender_name        TEXT,
  receiver_name      TEXT,
  receiver_account   TEXT,
  raw_data           TEXT,
  error              TEXT,
  idempotency_key    TEXT UNIQUE,
  webhook_url        TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_vr_ref  ON verification_requests(reference_number);
CREATE INDEX IF NOT EXISTS idx_vr_idem ON verification_requests(idempotency_key);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  key_hash     TEXT NOT NULL UNIQUE,
  key_prefix   TEXT NOT NULL,
  name         TEXT,
  permissions  TEXT NOT NULL DEFAULT '["verification:read","verification:write"]',
  enabled      INTEGER NOT NULL DEFAULT 1,
  is_admin     INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  request_count INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`);