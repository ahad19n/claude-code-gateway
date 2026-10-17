'use strict';
// SQLite storage for workstations and usage. Uses Node's built-in node:sqlite.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || '/data/gateway.db';

function open() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS workstations (
      name            TEXT PRIMARY KEY,
      key_hash        TEXT NOT NULL UNIQUE,
      enabled         INTEGER NOT NULL DEFAULT 1,
      blocked_models  TEXT NOT NULL DEFAULT '[]',   -- JSON array of glob patterns
      created_at      INTEGER NOT NULL,
      last_seen_at    INTEGER
    );

    CREATE TABLE IF NOT EXISTS usage (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                   INTEGER NOT NULL,          -- epoch ms, request start
      workstation          TEXT NOT NULL,
      session_id           TEXT,
      method               TEXT NOT NULL,
      path                 TEXT NOT NULL,
      model                TEXT,
      status               INTEGER,
      outcome              TEXT NOT NULL,             -- ok | blocked | upstream_error | client_aborted | gateway_error
      input_tokens         INTEGER,
      output_tokens        INTEGER,
      cache_write_tokens   INTEGER,
      cache_read_tokens    INTEGER,
      web_search_requests  INTEGER,
      duration_ms          INTEGER,
      request_id           TEXT,
      error_type           TEXT,
      util_5h              REAL,
      util_7d              REAL
    );
    CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
    CREATE INDEX IF NOT EXISTS usage_ws_ts ON usage(workstation, ts);

    CREATE TABLE IF NOT EXISTS plan_status (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      updated_at  INTEGER NOT NULL,
      headers     TEXT NOT NULL                       -- JSON of anthropic-ratelimit-* headers
    );
  `);
  return db;
}

function hashKey(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

function newKey(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 16) || 'ws';
  return `gw-${slug}-${crypto.randomBytes(24).toString('base64url')}`;
}

module.exports = { open, hashKey, newKey, DB_PATH };
